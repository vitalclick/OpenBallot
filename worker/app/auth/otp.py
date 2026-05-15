"""One-time password generation, hashing, and verification.

Design notes
  * Codes are 6 digits, zero-padded. Generated with `secrets.randbelow` so
    the distribution is uniform and cryptographically random.
  * Codes are NEVER stored in the clear. We persist SHA-256(code + salt)
    with a per-row 16-byte salt - constant-time comparison on verify.
  * Each OTP row tracks an attempts counter; after `otp_max_attempts` the
    row is locked even if the code would otherwise match. Prevents online
    brute-force.
  * On success the row is marked consumed - it cannot be replayed.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4


def generate_otp(length: int = 6) -> str:
    """Cryptographically random N-digit code, zero-padded."""
    upper = 10**length
    return str(secrets.randbelow(upper)).zfill(length)


def generate_salt() -> str:
    """16 bytes of randomness, hex-encoded (32 chars)."""
    return secrets.token_hex(16)


def hash_otp(code: str, salt: str) -> str:
    """SHA-256(salt || code). Hex-encoded, 64 chars."""
    return hashlib.sha256((salt + code).encode("utf-8")).hexdigest()


def constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


@dataclass
class OTPRecord:
    id: UUID
    phone_e164: str
    code_hash: str
    code_salt: str
    expires_at: datetime
    attempts: int = 0
    consumed_at: datetime | None = None


class OTPService:
    """Pure logic. DB I/O is the caller's responsibility - keeps this
    trivially unit-testable."""

    def __init__(self, ttl_seconds: int = 300, max_attempts: int = 5, length: int = 6):
        self.ttl_seconds = ttl_seconds
        self.max_attempts = max_attempts
        self.length = length

    def create(self, phone_e164: str) -> tuple[OTPRecord, str]:
        """Returns (record_to_store, code_to_send). The code never leaves
        this function except via the SMS provider."""
        code = generate_otp(self.length)
        salt = generate_salt()
        rec = OTPRecord(
            id=uuid4(),
            phone_e164=phone_e164,
            code_hash=hash_otp(code, salt),
            code_salt=salt,
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=self.ttl_seconds),
        )
        return rec, code

    def verify(self, rec: OTPRecord, submitted_code: str) -> tuple[bool, str]:
        """Returns (ok, reason). Mutates rec.attempts. Caller persists.

        Reasons (when ok=False):
          - "expired"           : OTP TTL passed
          - "already_consumed"  : OTP was already used successfully
          - "too_many_attempts" : attempts >= max_attempts
          - "code_mismatch"     : the submitted code is wrong
        """
        now = datetime.now(timezone.utc)
        if rec.consumed_at is not None:
            return False, "already_consumed"
        if rec.expires_at < now:
            return False, "expired"
        if rec.attempts >= self.max_attempts:
            return False, "too_many_attempts"

        rec.attempts += 1
        expected = hash_otp(submitted_code, rec.code_salt)
        if not constant_time_eq(expected, rec.code_hash):
            return False, "code_mismatch"

        rec.consumed_at = now
        return True, "ok"
