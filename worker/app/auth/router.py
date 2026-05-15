"""FastAPI router for agent auth.

Endpoints:
  POST /v1/auth/request-otp   - generate + persist OTP, dispatch SMS
  POST /v1/auth/verify-otp    - check OTP, bind device, issue JWT
  GET  /v1/auth/me            - return agent profile from Bearer token

The router is thin glue: every decision (rate limit, OTP, device binding,
token issuance) lives in the modules under app.auth and is unit-tested
without any FastAPI dependency.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import jwt as jwt_lib
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import settings
from ..db import pool
from . import (
    OTPService,
    device_fingerprint_hash,
    evaluate_device_change,
    evaluate_rate_limit,
    issue_agent_token,
    verify_agent_token,
)
from .otp import OTPRecord
from .phone import normalise_phone
from .twilio_adapter import build_default_adapter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/auth", tags=["auth"])


def _sms():
    s = settings()
    return build_default_adapter(
        enabled=s.twilio_enabled,
        account_sid=s.twilio_account_sid,
        auth_token=s.twilio_auth_token,
        from_number=s.twilio_from,
    )


class RequestOtpIn(BaseModel):
    phone: str = Field(min_length=4, max_length=32)


class RequestOtpOut(BaseModel):
    status: str
    expires_in_seconds: int


class VerifyOtpIn(BaseModel):
    phone: str
    code: str = Field(min_length=4, max_length=8)
    device_fingerprint: str = Field(min_length=8, max_length=128)


class VerifyOtpOut(BaseModel):
    token: str
    expires_at: datetime
    agent: dict


@router.post("/request-otp", response_model=RequestOtpOut)
async def request_otp(body: RequestOtpIn, request: Request):
    s = settings()
    try:
        phone = normalise_phone(body.phone)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ip = request.client.host if request.client else None

    async with pool().acquire() as conn:
        phone_times = await conn.fetch(
            """
            SELECT created_at FROM auth_events
            WHERE phone_e164 = $1 AND event_type = 'otp.requested'
              AND created_at > NOW() - INTERVAL '10 minutes'
            """,
            phone,
        )
        ip_times = (
            await conn.fetch(
                """
                SELECT created_at FROM auth_events
                WHERE ip_address = $1 AND event_type = 'otp.requested'
                  AND created_at > NOW() - INTERVAL '1 hour'
                """,
                ip,
            )
            if ip
            else []
        )

        decision = evaluate_rate_limit(
            phone_request_times=[r["created_at"] for r in phone_times],
            ip_request_times=[r["created_at"] for r in ip_times],
            phone_window_seconds=600,
            phone_max=s.otp_max_requests_per_phone_per_10min,
            ip_window_seconds=3600,
            ip_max=s.otp_max_requests_per_ip_per_hour,
        )
        if not decision.allow:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": decision.reason,
                    "retry_after_seconds": decision.retry_after_seconds,
                },
                headers={"Retry-After": str(decision.retry_after_seconds)},
            )

        svc = OTPService(
            ttl_seconds=s.otp_ttl_seconds,
            max_attempts=s.otp_max_attempts,
            length=s.otp_length,
        )
        rec, raw_code = svc.create(phone)

        await conn.execute(
            """
            INSERT INTO agent_otps (id, phone_e164, code_hash, code_salt, expires_at, requested_ip)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            rec.id,
            rec.phone_e164,
            rec.code_hash,
            rec.code_salt,
            rec.expires_at,
            ip,
        )
        await conn.execute(
            """
            INSERT INTO auth_events (phone_e164, event_type, ip_address, metadata)
            VALUES ($1, 'otp.requested', $2, $3::jsonb)
            """,
            phone,
            ip,
            {"otp_id": str(rec.id)},
        )

    result = await _sms().send(
        to_e164=phone,
        body=f"OpenBallot code: {raw_code}. Valid for {s.otp_ttl_seconds // 60} minutes. Do not share.",
    )
    if not result.ok:
        log.warning("sms.failed", extra={"phone": phone, "error": result.error})

    return RequestOtpOut(status="sent", expires_in_seconds=s.otp_ttl_seconds)


@router.post("/verify-otp", response_model=VerifyOtpOut)
async def verify_otp(body: VerifyOtpIn, request: Request):
    s = settings()
    try:
        phone = normalise_phone(body.phone)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ip = request.client.host if request.client else None
    presented_dev_hash = device_fingerprint_hash(body.device_fingerprint)

    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, phone_e164, code_hash, code_salt, expires_at, attempts, consumed_at
              FROM agent_otps
             WHERE phone_e164 = $1 AND consumed_at IS NULL
             ORDER BY requested_at DESC
             LIMIT 1
            """,
            phone,
        )
        if row is None:
            raise HTTPException(status_code=400, detail={"code": "no_active_otp"})

        rec = OTPRecord(
            id=row["id"],
            phone_e164=row["phone_e164"],
            code_hash=row["code_hash"],
            code_salt=row["code_salt"],
            expires_at=row["expires_at"],
            attempts=row["attempts"],
            consumed_at=row["consumed_at"],
        )

        svc = OTPService(
            ttl_seconds=s.otp_ttl_seconds,
            max_attempts=s.otp_max_attempts,
            length=s.otp_length,
        )
        ok, reason = svc.verify(rec, body.code)

        # Persist mutated attempts/consumed_at regardless of outcome.
        await conn.execute(
            "UPDATE agent_otps SET attempts = $1, consumed_at = $2 WHERE id = $3",
            rec.attempts,
            rec.consumed_at,
            rec.id,
        )
        await conn.execute(
            """
            INSERT INTO auth_events (phone_e164, event_type, ip_address, metadata)
            VALUES ($1, $2, $3, $4::jsonb)
            """,
            phone,
            "otp.verified" if ok else "otp.failed",
            ip,
            {"reason": reason, "otp_id": str(rec.id)},
        )
        if not ok:
            raise HTTPException(status_code=400, detail={"code": reason})

        # Find the agent record. We don't auto-register from auth-time;
        # party admins upload rosters separately. A phone with no agent
        # row should not be issued a token.
        agent = await conn.fetchrow(
            """
            SELECT id, role, full_name, party_code, assigned_pu_code,
                   device_fingerprint
              FROM agents
             WHERE phone_e164 = $1
            """,
            phone,
        )
        if agent is None:
            raise HTTPException(
                status_code=403,
                detail={"code": "phone_not_provisioned"},
            )

        dev_decision = evaluate_device_change(
            agent["device_fingerprint"], presented_dev_hash
        )
        if not dev_decision.allow:
            await conn.execute(
                """
                INSERT INTO pending_device_changes (agent_id, new_fingerprint, ip_address)
                VALUES ($1, $2, $3)
                """,
                agent["id"],
                presented_dev_hash,
                ip,
            )
            await conn.execute(
                """
                INSERT INTO auth_events (phone_e164, agent_id, event_type, ip_address, device_fingerprint)
                VALUES ($1, $2, 'login.denied', $3, $4)
                """,
                phone,
                agent["id"],
                ip,
                presented_dev_hash,
            )
            raise HTTPException(
                status_code=403,
                detail={"code": dev_decision.reason},
            )

        if dev_decision.reason == "first_login":
            await conn.execute(
                "UPDATE agents SET device_fingerprint = $1, last_login_at = NOW() WHERE id = $2",
                presented_dev_hash,
                agent["id"],
            )
        else:
            await conn.execute(
                "UPDATE agents SET last_login_at = NOW() WHERE id = $1", agent["id"]
            )

        await conn.execute(
            """
            INSERT INTO auth_events (phone_e164, agent_id, event_type, ip_address, device_fingerprint)
            VALUES ($1, $2, 'login.success', $3, $4)
            """,
            phone,
            agent["id"],
            ip,
            presented_dev_hash,
        )

    token = issue_agent_token(
        secret=s.agent_jwt_secret,
        agent_id=str(agent["id"]),
        role=agent["role"],
        party=agent["party_code"],
        pu_code=agent["assigned_pu_code"],
        device_fingerprint_hash=presented_dev_hash,
        ttl_seconds=s.agent_jwt_ttl_seconds,
    )
    expires_at = datetime.fromtimestamp(
        datetime.now(tz=timezone.utc).timestamp() + s.agent_jwt_ttl_seconds, tz=timezone.utc
    )
    return VerifyOtpOut(
        token=token,
        expires_at=expires_at,
        agent={
            "id": str(agent["id"]),
            "role": agent["role"],
            "full_name": agent["full_name"],
            "party_code": agent["party_code"],
            "assigned_pu_code": agent["assigned_pu_code"],
        },
    )


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail={"code": "missing_token"})
    return authorization.split(" ", 1)[1].strip()


def require_agent(
    authorization: str | None = Header(default=None, alias="Authorization"),
    x_device_fingerprint: str | None = Header(default=None, alias="X-Device-Fingerprint"),
):
    """FastAPI dependency. Returns the validated AgentClaims or raises 401."""
    token = _bearer(authorization)
    try:
        claims = verify_agent_token(token, settings().agent_jwt_secret)
    except jwt_lib.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail={"code": "token_expired"})
    except jwt_lib.InvalidTokenError:
        raise HTTPException(status_code=401, detail={"code": "invalid_token"})

    if x_device_fingerprint:
        if device_fingerprint_hash(x_device_fingerprint) != claims.dev:
            raise HTTPException(status_code=401, detail={"code": "device_mismatch"})

    return claims


@router.get("/me")
async def me(claims=Depends(require_agent)):
    return {
        "agent_id": claims.sub,
        "role": claims.role,
        "party": claims.party,
        "pu": claims.pu,
        "expires_at": claims.exp.isoformat(),
    }
