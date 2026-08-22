"""FastAPI admin router.

Two distinct surfaces share the prefix:

  /v1/admin/roster      - party-admin onboarding
  /v1/admin/review/*    - consortium reviewer queue

Auth requires the agent JWT to carry role in {party_admin,
consortium_reviewer}. The require_admin and require_reviewer
dependencies enforce this; mismatched roles get 403.
"""

from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..auth.jwt_tokens import AgentClaims
from ..auth.router import require_agent
from ..auth.twilio_adapter import build_default_adapter
from ..config import settings
from ..db import pool
from . import csv_import, review

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/admin", tags=["admin"])


# ─── Role guards ────────────────────────────────────────────────────────────


def require_party_admin(claims: AgentClaims = Depends(require_agent)) -> AgentClaims:
    if claims.role != "party_admin":
        raise HTTPException(status_code=403, detail={"code": "not_party_admin"})
    return claims


def require_reviewer(claims: AgentClaims = Depends(require_agent)) -> AgentClaims:
    if claims.role not in {"consortium_reviewer", "inec_liaison"}:
        raise HTTPException(status_code=403, detail={"code": "not_reviewer"})
    return claims


# ─── Roster import ──────────────────────────────────────────────────────────


class RosterImportResponse(BaseModel):
    inserted: int
    skipped_existing: int
    sms_dispatched: int
    party: str


@router.post("/roster", response_model=RosterImportResponse)
async def import_roster(
    file: UploadFile = File(...),
    dispatch_sms: bool = True,
    admin: AgentClaims = Depends(require_party_admin),
):
    if not admin.party:
        raise HTTPException(status_code=403, detail={"code": "party_admin_without_party"})

    raw = (await file.read()).decode("utf-8", errors="replace")
    try:
        rows = csv_import.parse_roster_csv(raw)
    except csv_import.RosterImportError as e:
        raise HTTPException(
            status_code=400,
            detail={"code": "csv_invalid", "errors": e.errors},
        ) from e

    inserted = 0
    skipped = 0
    async with pool().acquire() as conn, conn.transaction():
        for row in rows:
            exists = await conn.fetchval(
                "SELECT 1 FROM agents WHERE phone_e164 = $1", row.phone_e164
            )
            if exists:
                skipped += 1
                continue
            pu_exists = await conn.fetchval(
                "SELECT 1 FROM polling_units WHERE pu_code = $1", row.pu_code
            )
            if not pu_exists:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "unknown_pu",
                        "message": f"polling unit {row.pu_code} not in registry (line {row.line})",
                    },
                )
            await conn.execute(
                """
                    INSERT INTO agents (
                      role, full_name, phone_e164, party_code,
                      assigned_pu_code, language
                    ) VALUES ('party_agent', $1, $2, $3, $4, $5)
                    """,
                row.full_name,
                row.phone_e164,
                admin.party,
                row.pu_code,
                row.language,
            )
            await conn.execute(
                """
                    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, event_data)
                    VALUES ('agent.provisioned', 'agent', $1, $2, $3::jsonb)
                    """,
                row.phone_e164,
                admin.sub,
                {
                    "party": admin.party,
                    "pu_code": row.pu_code,
                    "language": row.language,
                },
            )
            inserted += 1

    sms_dispatched = 0
    if dispatch_sms and inserted > 0:
        s = settings()
        adapter = build_default_adapter(
            enabled=s.twilio_enabled,
            account_sid=s.twilio_account_sid,
            auth_token=s.twilio_auth_token,
            from_number=s.twilio_from,
            whatsapp_from=s.whatsapp_from,
            whatsapp_template=s.whatsapp_template_otp,
        )
        for row in rows[: inserted]:   # only those newly inserted
            body = (
                f"You are registered as a {admin.party} agent for PU {row.pu_code}. "
                f"Sign in at https://openballot.ng/agent and request your code."
            )
            res = await adapter.send(to_e164=row.phone_e164, body=body)
            if res.ok:
                sms_dispatched += 1
            else:
                log.warning("admin.roster.sms_failed", extra={"phone": row.phone_e164, "err": res.error})

    return RosterImportResponse(
        inserted=inserted,
        skipped_existing=skipped,
        sms_dispatched=sms_dispatched,
        party=admin.party,
    )


# ─── Review queue ───────────────────────────────────────────────────────────


class QueueItem(BaseModel):
    submission_id: UUID
    election_id: str
    pu_code: str
    pu_name: str
    state_code: str
    image_url: str
    image_sha256: str
    submitted_at: str
    confidence_score: float
    extracted: dict
    validation_flags: dict
    party_code: str | None
    source_type: str


@router.get("/review/queue", response_model=list[QueueItem])
async def review_queue(
    state: str | None = None,
    limit: int = 100,
    reviewer: AgentClaims = Depends(require_reviewer),
):
    sql = """
        SELECT s.id, s.election_id, s.pu_code, pu.pu_name, pu.state_code,
               s.image_url, s.image_sha256, s.submitted_at,
               s.confidence_score, s.extracted_data, s.validation_flags,
               s.party_code, s.source_type
          FROM ec8a_submissions s
          JOIN polling_units pu ON pu.pu_code = s.pu_code
         WHERE s.review_status = 'pending_review'
    """
    params: list = []
    if state:
        sql += " AND pu.state_code = $1"
        params.append(state)
    sql += f" ORDER BY s.submitted_at ASC LIMIT ${len(params) + 1}"
    params.append(limit)

    async with pool().acquire() as conn:
        rows = await conn.fetch(sql, *params)

    return [
        QueueItem(
            submission_id=r["id"],
            election_id=r["election_id"],
            pu_code=r["pu_code"],
            pu_name=r["pu_name"],
            state_code=r["state_code"],
            image_url=r["image_url"],
            image_sha256=r["image_sha256"],
            submitted_at=r["submitted_at"].isoformat(),
            confidence_score=float(r["confidence_score"] or 0),
            extracted=r["extracted_data"] if isinstance(r["extracted_data"], dict) else {},
            validation_flags=r["validation_flags"] or {},
            party_code=r["party_code"],
            source_type=r["source_type"],
        )
        for r in rows
    ]


class ReviewDecisionIn(BaseModel):
    action: Literal["approve", "reject"]
    reason: str | None = Field(default=None, description="Required when action=reject")


class ReviewDecisionOut(BaseModel):
    submission_id: UUID
    new_status: str
    pu_code: str
    verification_status: str


@router.post("/review/submissions/{submission_id}", response_model=ReviewDecisionOut)
async def review_submission(
    submission_id: UUID,
    body: ReviewDecisionIn,
    reviewer: AgentClaims = Depends(require_reviewer),
):
    try:
        action = review.ReviewAction(body.action)
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"code": "bad_action"}) from e

    async with pool().acquire() as conn, conn.transaction():
        try:
            outcome = await review.apply_review(
                conn,
                submission_id=submission_id,
                action=action,
                reviewer_id=UUID(reviewer.sub),
                reason=body.reason,
            )
        except ValueError as e:
            raise HTTPException(
                status_code=400,
                detail={"code": "review_invalid", "message": str(e)},
            ) from e

    return ReviewDecisionOut(
        submission_id=outcome.submission_id,
        new_status=outcome.new_status,
        pu_code=outcome.pu_code,
        verification_status=outcome.verification_status,
    )
