"""Observer registration + admin approval endpoints.

Three surfaces:

  POST /v1/observers/register        public; an observer self-registers
                                     with their INEC accreditation
                                     credential. Lands in
                                     observer_registrations.pending.

  GET  /v1/admin/observers/queue     consortium_reviewer | inec_liaison;
                                     paginated list of pending records.

  POST /v1/admin/observers/{id}/decision   reviewer; approve or reject.
                                     On approval, also INSERTs an
                                     agents row with role='observer',
                                     so the observer can OTP-login and
                                     start submitting EC8As.

All decisions land in the audit_log; the SQL chain trigger hashes
them.
"""

from __future__ import annotations

import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

from ..auth.jwt_tokens import AgentClaims
from ..auth.phone import normalise_phone
from ..auth.router import require_agent
from ..db import pool

router = APIRouter(prefix="/v1", tags=["observers"])


def require_observer_reviewer(claims: AgentClaims = Depends(require_agent)) -> AgentClaims:
    if claims.role not in {"consortium_reviewer", "inec_liaison"}:
        raise HTTPException(status_code=403, detail={"code": "not_reviewer"})
    return claims


# ─── Public registration ────────────────────────────────────────────────────


class ObserverRegistrationIn(BaseModel):
    full_name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    phone: str
    observer_org: str = Field(min_length=2, max_length=200)
    inec_accreditation_id: str | None = None
    accreditation_doc_url: str | None = None
    accreditation_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    states_covered: list[str] | None = None
    language: Literal["en", "ha", "yo", "ig", "pcm"] = "en"


class ObserverRegistrationOut(BaseModel):
    registration_id: UUID
    status: str
    message: str


@router.post("/observers/register", response_model=ObserverRegistrationOut)
async def register(body: ObserverRegistrationIn, request: Request):
    try:
        phone = normalise_phone(body.phone)
    except ValueError as e:
        raise HTTPException(
            status_code=400, detail={"code": "bad_phone", "message": str(e)}
        ) from e

    ip = request.client.host if request.client else None

    async with pool().acquire() as conn:
        # Reject duplicates up front with a clear message rather than
        # leaning on the UNIQUE constraint's IntegrityError.
        existing = await conn.fetchval(
            "SELECT 1 FROM observer_registrations WHERE phone_e164 = $1 OR email = $2",
            phone,
            body.email,
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail={"code": "already_registered",
                        "message": "An observer with this phone or email is already on file."},
            )
        registration_id = await conn.fetchval(
            """
            INSERT INTO observer_registrations (
              full_name, email, phone_e164, observer_org,
              inec_accreditation_id, accreditation_doc_url, accreditation_sha256,
              states_covered, language, submitter_ip
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING id
            """,
            body.full_name,
            body.email,
            phone,
            body.observer_org,
            body.inec_accreditation_id,
            body.accreditation_doc_url,
            body.accreditation_sha256,
            body.states_covered,
            body.language,
            ip,
        )
        await conn.execute(
            """
            INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
            VALUES ('observer.registered', 'observer_registration', $1, $2::jsonb)
            """,
            str(registration_id),
            json.dumps({"observer_org": body.observer_org, "language": body.language}),
        )

    return ObserverRegistrationOut(
        registration_id=registration_id,
        status="pending",
        message="Submitted for consortium review.",
    )


# ─── Admin review queue ─────────────────────────────────────────────────────


class ObserverQueueItem(BaseModel):
    id: UUID
    full_name: str
    email: str
    phone_e164: str
    observer_org: str
    inec_accreditation_id: str | None
    accreditation_doc_url: str | None
    states_covered: list[str] | None
    language: str
    submitted_at: str


@router.get("/admin/observers/queue", response_model=list[ObserverQueueItem])
async def queue(
    limit: int = 100,
    reviewer: AgentClaims = Depends(require_observer_reviewer),
):
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, full_name, email, phone_e164, observer_org,
                   inec_accreditation_id, accreditation_doc_url,
                   states_covered, language, submitted_at
              FROM observer_registrations
             WHERE review_status = 'pending'
             ORDER BY submitted_at ASC
             LIMIT $1
            """,
            limit,
        )
    return [
        ObserverQueueItem(
            id=r["id"],
            full_name=r["full_name"],
            email=r["email"],
            phone_e164=r["phone_e164"],
            observer_org=r["observer_org"],
            inec_accreditation_id=r["inec_accreditation_id"],
            accreditation_doc_url=r["accreditation_doc_url"],
            states_covered=r["states_covered"],
            language=r["language"],
            submitted_at=r["submitted_at"].isoformat(),
        )
        for r in rows
    ]


class ReviewIn(BaseModel):
    action: Literal["approve", "reject"]
    reason: str | None = None


class ReviewOut(BaseModel):
    registration_id: UUID
    new_status: str
    agent_id: UUID | None


@router.post("/admin/observers/{registration_id}/decision", response_model=ReviewOut)
async def decide(
    registration_id: UUID,
    body: ReviewIn,
    reviewer: AgentClaims = Depends(require_observer_reviewer),
):
    if body.action == "reject" and not (body.reason or "").strip():
        raise HTTPException(
            status_code=400,
            detail={"code": "reject_requires_reason"},
        )

    async with pool().acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """
                SELECT id, full_name, email, phone_e164, observer_org, language,
                       review_status
                  FROM observer_registrations
                 WHERE id = $1
                 FOR UPDATE
                """,
            registration_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        if row["review_status"] != "pending":
            raise HTTPException(
                status_code=400,
                detail={"code": "already_decided",
                        "message": f"current status: {row['review_status']}"},
            )

        agent_id = None
        if body.action == "approve":
            agent_id = await conn.fetchval(
                """
                    INSERT INTO agents (
                      role, full_name, phone_e164, observer_org,
                      credential_ref, language
                    ) VALUES ('observer', $1, $2, $3, $4, $5)
                    RETURNING id
                    """,
                row["full_name"],
                row["phone_e164"],
                row["observer_org"],
                None,
                row["language"],
            )
            await conn.execute(
                """
                    UPDATE observer_registrations
                       SET review_status = 'approved',
                           reviewed_by = $1,
                           reviewed_at = NOW(),
                           agent_id = $2
                     WHERE id = $3
                    """,
                UUID(reviewer.sub),
                agent_id,
                registration_id,
            )
            event_type = "observer.approved"
        else:
            await conn.execute(
                """
                    UPDATE observer_registrations
                       SET review_status = 'rejected',
                           reviewed_by = $1,
                           reviewed_at = NOW(),
                           rejection_reason = $2
                     WHERE id = $3
                    """,
                UUID(reviewer.sub),
                body.reason,
                registration_id,
            )
            event_type = "observer.rejected"

        await conn.execute(
            """
                INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, event_data)
                VALUES ($1, 'observer_registration', $2, $3, $4::jsonb)
                """,
            event_type,
            str(registration_id),
            UUID(reviewer.sub),
            json.dumps({
                "observer_org": row["observer_org"],
                "reason": body.reason,
                "agent_id": str(agent_id) if agent_id else None,
            }),
        )

    return ReviewOut(
        registration_id=registration_id,
        new_status="approved" if body.action == "approve" else "rejected",
        agent_id=agent_id,
    )
