"""Tests for OTP generation, hashing, and verification.

The OTP layer is pure logic with no DB I/O - all the tests live here.
We exercise the four failure modes: code mismatch, expired, already
consumed, too-many-attempts.
"""

from datetime import datetime, timedelta, timezone

from app.auth.otp import OTPService, generate_otp, hash_otp


def test_generate_otp_is_zero_padded_and_correct_length():
    for _ in range(50):
        code = generate_otp(6)
        assert len(code) == 6
        assert code.isdigit()


def test_hash_is_deterministic_and_depends_on_salt():
    h1 = hash_otp("123456", "saltA")
    h2 = hash_otp("123456", "saltA")
    h3 = hash_otp("123456", "saltB")
    assert h1 == h2
    assert h1 != h3
    assert len(h1) == 64


def test_create_returns_a_record_and_a_code_not_stored_raw():
    rec, code = OTPService().create("+2348035550101")
    assert len(code) == 6
    assert rec.code_hash != code
    # The hash must actually match the salt+code combination
    assert hash_otp(code, rec.code_salt) == rec.code_hash


def test_verify_happy_path():
    svc = OTPService()
    rec, code = svc.create("+2348035550101")
    ok, reason = svc.verify(rec, code)
    assert ok is True
    assert reason == "ok"
    assert rec.consumed_at is not None


def test_verify_wrong_code_increments_attempts_and_rejects():
    svc = OTPService(max_attempts=3)
    rec, _ = svc.create("+2348035550101")
    ok, reason = svc.verify(rec, "000000")
    assert ok is False
    assert reason == "code_mismatch"
    assert rec.attempts == 1
    assert rec.consumed_at is None


def test_verify_locks_after_max_attempts():
    svc = OTPService(max_attempts=3)
    rec, code = svc.create("+2348035550101")
    for _ in range(3):
        svc.verify(rec, "000000")
    # Fourth attempt - even with correct code, must fail
    ok, reason = svc.verify(rec, code)
    assert ok is False
    assert reason == "too_many_attempts"


def test_verify_rejects_expired():
    svc = OTPService()
    rec, code = svc.create("+2348035550101")
    rec.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    ok, reason = svc.verify(rec, code)
    assert ok is False
    assert reason == "expired"


def test_verify_rejects_replay():
    svc = OTPService()
    rec, code = svc.create("+2348035550101")
    svc.verify(rec, code)               # first time: ok
    ok, reason = svc.verify(rec, code)  # second time: replay
    assert ok is False
    assert reason == "already_consumed"
