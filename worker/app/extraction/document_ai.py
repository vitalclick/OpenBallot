"""Google Document AI extractor.

Production primary backend. Talks to a Document AI processor that has
been trained on EC8A samples - either a custom processor (preferred,
emits named entities) or the generic Form Parser (we then map
key-value pairs to our schema using fuzzy field aliases).

Operator notes
  * Required env:
      GOOGLE_DOCUMENT_AI_PROJECT
      GOOGLE_DOCUMENT_AI_PROCESSOR
      GOOGLE_APPLICATION_CREDENTIALS_JSON (or GOOGLE_APPLICATION_CREDENTIALS pointing at a file)
  * The processor's region (us / eu) is encoded in the processor resource
    name; we read it from settings to construct the regional API endpoint.
  * Document AI bills per page. EC8A is single-page so each extraction is
    one billable unit (~$0.05 - $0.03 depending on volume tier).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC
from typing import Any

import httpx

from ..config import settings
from ..models import ExtractedEC8A
from .arithmetic import arithmetic_consistent
from .engine import ExtractionResult, Extractor

log = logging.getLogger(__name__)


# Field aliases for the generic Form Parser fallback path. Each tuple is
# (canonical_field, list_of_label_regexes). The regexes are matched
# case-insensitively against the form's key text.
_FIELD_ALIASES: list[tuple[str, list[str]]] = [
    ("pu_code", [r"polling.?unit.?code", r"pu.?code"]),
    ("registered_voters", [r"registered.?voters", r"total.?registered"]),
    ("accredited_voters", [r"accredited.?voters", r"total.?accredited"]),
    ("total_valid_votes", [r"total.?valid.?votes", r"valid.?votes"]),
    ("rejected_ballots", [r"rejected.?(ballots|votes)"]),
    ("total_votes_cast", [r"total.?(votes|ballot).?cast", r"votes.?cast"]),
]

_INT_NOISE = re.compile(r"[^\d-]")


def _to_int(s: str | None) -> int:
    if s is None:
        return 0
    cleaned = _INT_NOISE.sub("", s)
    return int(cleaned) if cleaned else 0


def _match_field(label: str) -> str | None:
    label_l = label.lower()
    for canonical, patterns in _FIELD_ALIASES:
        for p in patterns:
            if re.search(p, label_l):
                return canonical
    return None


class DocumentAIExtractor(Extractor):
    """Document AI - primary OCR backend."""

    name = "document_ai"

    def __init__(
        self,
        *,
        project: str,
        processor: str,
        location: str = "us",
        credentials_json: str | None = None,
        timeout_seconds: float = 60.0,
    ):
        self.project = project
        self.processor = processor
        self.location = location
        self.credentials_json = credentials_json
        self.timeout = timeout_seconds
        self._endpoint = (
            f"https://{location}-documentai.googleapis.com/v1/"
            f"projects/{project}/locations/{location}/processors/{processor}:process"
        )
        # Cached access token + expiry; we fetch it lazily via the metadata
        # endpoint when running on GCP, or via service-account JSON otherwise.
        self._access_token: str | None = None
        self._token_expires_at: float = 0.0

    async def _get_access_token(self) -> str:
        # In production this uses google-auth's google.oauth2.service_account
        # to mint a JWT-signed access token. We keep that path behind a
        # method so unit tests can stub it without touching Google libs.
        from datetime import datetime
        now = datetime.now(UTC).timestamp()
        if self._access_token and self._token_expires_at > now + 60:
            return self._access_token

        from google.auth.transport.requests import Request
        from google.oauth2 import service_account

        if self.credentials_json:
            info = json.loads(self.credentials_json)
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
        else:
            # Application default credentials path (e.g. running on GCP).
            from google.auth import default
            creds, _ = default(scopes=["https://www.googleapis.com/auth/cloud-platform"])

        creds.refresh(Request())
        self._access_token = creds.token
        self._token_expires_at = creds.expiry.timestamp() if creds.expiry else now + 300
        return self._access_token

    async def _call_processor(self, image_bytes: bytes) -> dict[str, Any]:
        import base64
        token = await self._get_access_token()
        body = {
            "rawDocument": {
                "content": base64.b64encode(image_bytes).decode("ascii"),
                "mimeType": "image/jpeg",
            },
            "fieldMask": "entities,pages.formFields",
        }
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(
                self._endpoint,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
        if r.status_code >= 300:
            raise RuntimeError(f"Document AI HTTP {r.status_code}: {r.text[:300]}")
        return r.json()

    async def _fetch_image_bytes(self, image_url: str) -> bytes:
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.get(image_url)
            r.raise_for_status()
            return r.content

    async def extract(self, image_url: str, pu_code: str) -> ExtractionResult:
        image_bytes = await self._fetch_image_bytes(image_url)
        raw = await self._call_processor(image_bytes)
        return self._parse_response(raw, pu_code, image_url)

    # ─── Response parsing ────────────────────────────────────────────────────
    #
    # Two response shapes to handle:
    #   1. Custom EC8A processor: response has `document.entities` with
    #      `type` matching our canonical field names directly.
    #   2. Generic Form Parser: response has `document.pages[].formFields`
    #      with key/value pairs we have to alias-match.
    #
    # We prefer (1) when present, fall back to (2). Per-field confidence is
    # taken from whichever produced the value.

    def _parse_response(
        self,
        response: dict[str, Any],
        pu_code: str,
        image_url: str,
    ) -> ExtractionResult:
        document = response.get("document", response)
        entities = document.get("entities", [])
        form_fields = []
        for page in document.get("pages", []):
            form_fields.extend(page.get("formFields", []))

        per_field_confidence: dict[str, float] = {}
        scalar_values: dict[str, int] = {}
        candidate_votes: dict[str, int] = {}
        # Signature/stamp booleans - some custom processors emit explicit
        # entities; the generic parser does not, in which case we default
        # to true (the worker tracks the source image so reviewers can
        # disagree).
        presiding_signed = True
        stamp_present = True
        signatures_detected = 0

        # ── Pass 1: custom-processor entities (preferred) ────────────────
        for ent in entities:
            t = (ent.get("type") or "").lower()
            text = ent.get("mentionText") or ""
            conf = float(ent.get("confidence", 0.0))

            if t in {"pu_code", "polling_unit_code"}:
                if not pu_code or pu_code == "unknown":
                    pu_code = text.strip()
                per_field_confidence["pu_code"] = conf
            elif t in {"registered_voters", "accredited_voters", "total_valid_votes",
                       "rejected_ballots", "total_votes_cast"}:
                scalar_values[t] = _to_int(text)
                per_field_confidence[t] = conf
            elif t.startswith(("party_", "candidate_")):
                # Format: party_APC, candidate_PDP - the suffix is the party code
                party = t.split("_", 1)[1].upper()
                candidate_votes[party] = _to_int(text)
                per_field_confidence[f"candidate_votes.{party}"] = conf
            elif t == "presiding_officer_signed":
                presiding_signed = text.strip().lower() in {"true", "yes", "1", "y"}
            elif t == "official_stamp_present":
                stamp_present = text.strip().lower() in {"true", "yes", "1", "y"}
            elif t == "agent_signatures_detected":
                signatures_detected = _to_int(text)

        # ── Pass 2: generic form fields (fallback) ───────────────────────
        for ff in form_fields:
            key_text = self._text_segment(ff.get("fieldName"), document)
            val_text = self._text_segment(ff.get("fieldValue"), document)
            conf = float(ff.get("fieldValue", {}).get("confidence", 0.0))
            canonical = _match_field(key_text)
            if canonical and canonical not in scalar_values and canonical != "pu_code":
                scalar_values[canonical] = _to_int(val_text)
                per_field_confidence[canonical] = conf
            elif canonical == "pu_code" and "pu_code" not in per_field_confidence:
                pu_code = val_text.strip()
                per_field_confidence["pu_code"] = conf

        # ── Build the ExtractedEC8A ──────────────────────────────────────
        if not candidate_votes:
            # The custom processor didn't emit per-party entities; we cannot
            # produce a valid extraction. Raise so the engine falls back
            # to the secondary backend instead of returning bad data.
            raise RuntimeError("Document AI returned no candidate vote entities")

        extracted = ExtractedEC8A(
            pu_code=pu_code or "unknown",
            registered_voters=scalar_values.get("registered_voters", 0),
            accredited_voters=scalar_values.get("accredited_voters", 0),
            candidate_votes=candidate_votes,
            total_valid_votes=scalar_values.get("total_valid_votes", sum(candidate_votes.values())),
            rejected_ballots=scalar_values.get("rejected_ballots", 0),
            total_votes_cast=scalar_values.get(
                "total_votes_cast",
                scalar_values.get("total_valid_votes", sum(candidate_votes.values()))
                + scalar_values.get("rejected_ballots", 0),
            ),
            presiding_officer_signed=presiding_signed,
            agent_signatures_detected=signatures_detected,
            official_stamp_present=stamp_present,
        )

        # Aggregate confidence: arithmetic mean of per-field scores.
        confidence_score = (
            sum(per_field_confidence.values()) / max(1, len(per_field_confidence))
        ) if per_field_confidence else 0.0

        return ExtractionResult(
            extracted=extracted,
            confidence_score=confidence_score,
            per_field_confidence=per_field_confidence,
            backend_used=self.name,
            arithmetic=arithmetic_consistent(extracted),
            raw_response={"image_url": image_url, "processor": self.processor},
        )

    @staticmethod
    def _text_segment(node: dict | None, document: dict) -> str:
        """Document AI returns text via offset references into document.text.
        For our purposes the value text is also available on the node
        directly, so we fall back to that if textAnchor parsing isn't
        worth the complexity."""
        if not node:
            return ""
        # Newer responses include a denormalised `mentionText`
        if "mentionText" in node:
            return node["mentionText"]
        return node.get("text", "")


def build_from_settings() -> DocumentAIExtractor | None:
    """Factory: returns the real extractor if Document AI is configured,
    None otherwise. Caller substitutes a stub on None."""
    s = settings()
    if not s.google_document_ai_project or not s.google_document_ai_processor:
        return None
    import os
    return DocumentAIExtractor(
        project=s.google_document_ai_project,
        processor=s.google_document_ai_processor,
        location=os.environ.get("GOOGLE_DOCUMENT_AI_LOCATION", "us"),
        credentials_json=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON"),
    )
