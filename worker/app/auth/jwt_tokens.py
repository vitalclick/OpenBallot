"""Agent JWT issuance and verification.

The token carries the minimum identity needed for write-path
authorisation: agent id, role, assigned polling unit (party agents
only), and a hash of the device fingerprint. The handler that processes
EC8A uploads checks `dev` against the SHA-256 of the device fingerprint
the PWA presents in a header - a stolen token from a different device
won't work.

Algorithm is HS256. Asymmetric keys would be cleaner for a multi-service
deployment but HS256 keeps the dependency surface small and we control
both signer and verifier (the worker).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

ALGORITHM = "HS256"


@dataclass
class AgentClaims:
    sub: str          # agent UUID
    role: str         # actor_role enum value
    party: str | None
    pu: str | None    # assigned polling unit
    dev: str | None   # device fingerprint hash
    iat: datetime
    exp: datetime


def issue_agent_token(
    *,
    secret: str,
    agent_id: str,
    role: str,
    party: str | None,
    pu_code: str | None,
    device_fingerprint_hash: str | None,
    ttl_seconds: int = 60 * 60 * 24,
) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": agent_id,
        "role": role,
        "party": party,
        "pu": pu_code,
        "dev": device_fingerprint_hash,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
        "iss": "openballot.ng",
    }
    return jwt.encode(payload, secret, algorithm=ALGORITHM)


def verify_agent_token(token: str, secret: str) -> AgentClaims:
    """Raises jwt.InvalidTokenError (or subclasses) on any failure.

    Callers should map InvalidTokenError to 401 and ExpiredSignatureError
    to a specific error message so the PWA knows to re-auth.
    """
    decoded = jwt.decode(token, secret, algorithms=[ALGORITHM], issuer="openballot.ng")
    return AgentClaims(
        sub=decoded["sub"],
        role=decoded["role"],
        party=decoded.get("party"),
        pu=decoded.get("pu"),
        dev=decoded.get("dev"),
        iat=datetime.fromtimestamp(decoded["iat"], tz=timezone.utc),
        exp=datetime.fromtimestamp(decoded["exp"], tz=timezone.utc),
    )
