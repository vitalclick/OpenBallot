"""GPT-4o Vision extractor.

Production fallback backend. Invoked when Document AI's confidence falls
below the floor or its arithmetic checks fail. Sends the EC8A image URL
to GPT-4o with a structured-output prompt; parses the JSON response into
our ExtractedEC8A schema.

The model is asked to surface its own per-field confidence and to refuse
to invent data - illegible fields come back null + low confidence rather
than guessed. The engine routes these to the human review queue.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from ..config import settings
from ..models import ExtractedEC8A
from .arithmetic import arithmetic_consistent
from .engine import ExtractionResult, Extractor
from .prompts import EXTRACTION_PROMPT, PROMPT_VERSION
from .errors import NotAnEC8AError
from .word_numbers import reconcile_votes

log = logging.getLogger(__name__)


class GPT4oVisionExtractor(Extractor):
    name = "gpt4o_vision"

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gpt-4o",
        timeout_seconds: float = 60.0,
        base_url: str = "https://api.openai.com/v1",
    ):
        self.api_key = api_key
        self.model = model
        self.timeout = timeout_seconds
        self.base_url = base_url.rstrip("/")

    async def _call_model(self, image_url: str) -> dict[str, Any]:
        body = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": EXTRACTION_PROMPT},
                        {"type": "image_url", "image_url": {"url": image_url, "detail": "high"}},
                    ],
                }
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.0,
            "max_tokens": 1500,
        }
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
        if r.status_code >= 300:
            raise RuntimeError(f"OpenAI HTTP {r.status_code}: {r.text[:300]}")
        return r.json()

    async def extract(self, image_url: str, pu_code: str) -> ExtractionResult:
        response = await self._call_model(image_url)
        content = (
            response.get("choices", [{}])[0]
            .get("message", {})
            .get("content")
            or "{}"
        )
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"GPT-4o returned non-JSON content: {e}: {content[:200]}")

        if parsed.get("error") == "not_an_ec8a":
            # A classification, not a failure. Raised as a typed error so the
            # caller can flag the submission for review and publish it with
            # that flag, rather than logging a generic extraction failure and
            # losing what the model actually told us (issue #71).
            raise NotAnEC8AError(
                "backend classified the image as not an EC8A",
                image_url=image_url,
            )

        return self._parse_response(parsed, pu_code, image_url)

    def _parse_response(
        self,
        parsed: dict[str, Any],
        pu_code_hint: str,
        image_url: str,
    ) -> ExtractionResult:
        candidate_votes_raw = parsed.get("candidate_votes") or {}
        words_raw = parsed.get("candidate_votes_words") or {}
        candidate_votes_words = {
            str(k).strip().upper(): str(v)
            for k, v in words_raw.items()
            if v is not None and str(v).strip()
        }

        # Reconcile the two columns the form carries. When the model returned
        # the words, this both picks the reading they agree on and tells us
        # WHICH party is in doubt when they do not -- far better than an
        # arithmetic failure that condemns the whole extraction.
        if candidate_votes_words:
            figures_raw = {
                str(k).strip().upper(): v
                for k, v in candidate_votes_raw.items()
            }
            candidate_votes, reconciliation, votes_confidence = reconcile_votes(
                figures_raw, candidate_votes_words
            )
            disputed = [p for p, r in reconciliation.items() if r.needs_review]
        else:
            candidate_votes = {
                str(k).strip().upper(): int(v or 0)
                for k, v in candidate_votes_raw.items()
                if v is not None
            }
            reconciliation = {}
            votes_confidence = None
            disputed = []

        if not candidate_votes:
            raise RuntimeError("GPT-4o returned no candidate votes")

        extracted = ExtractedEC8A(
            pu_code=parsed.get("pu_code") or pu_code_hint or "unknown",
            registered_voters=int(parsed.get("registered_voters") or 0),
            accredited_voters=int(parsed.get("accredited_voters") or 0),
            candidate_votes=candidate_votes,
            candidate_votes_words=candidate_votes_words or None,
            total_valid_votes=int(parsed.get("total_valid_votes") or sum(candidate_votes.values())),
            rejected_ballots=int(parsed.get("rejected_ballots") or 0),
            total_votes_cast=int(parsed.get("total_votes_cast") or 0)
            or int(parsed.get("total_valid_votes") or sum(candidate_votes.values()))
            + int(parsed.get("rejected_ballots") or 0),
            presiding_officer_signed=bool(parsed.get("presiding_officer_signed", True)),
            agent_signatures_detected=int(parsed.get("agent_signatures_detected") or 0),
            official_stamp_present=bool(parsed.get("official_stamp_present", True)),
        )

        conf = parsed.get("confidence") or {}
        per_field_confidence: dict[str, float] = {
            k: float(v) for k, v in conf.items() if isinstance(v, (int, float))
        }

        # Agreement between the two columns is evidence about the votes that
        # the model's own self-reported confidence is not. Where we have it,
        # it wins: a model can be confidently wrong about a digit, but it
        # cannot easily be wrong about a digit AND its written form in the
        # same direction. Take the lower of the two so agreement can raise
        # confidence only as far as the model's own estimate allows.
        if votes_confidence is not None:
            per_field_confidence["candidate_votes"] = min(
                votes_confidence,
                per_field_confidence.get("candidate_votes", 1.0),
            )
        confidence_score = (
            sum(per_field_confidence.values()) / max(1, len(per_field_confidence))
        ) if per_field_confidence else 0.5

        return ExtractionResult(
            extracted=extracted,
            confidence_score=confidence_score,
            per_field_confidence=per_field_confidence,
            backend_used=self.name,
            arithmetic=arithmetic_consistent(extracted),
            raw_response={
                "image_url": image_url,
                "prompt_version": PROMPT_VERSION,
                "model": self.model,
                "votes_reconciliation": {
                    party: {
                        "figures": r.figures,
                        "words": r.words,
                        "agreed": r.agreed,
                    }
                    for party, r in reconciliation.items()
                },
                "votes_disputed": disputed,
            },
        )


def build_from_settings() -> GPT4oVisionExtractor | None:
    s = settings()
    if not s.openai_api_key:
        return None
    import os
    return GPT4oVisionExtractor(
        api_key=s.openai_api_key,
        model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
    )
