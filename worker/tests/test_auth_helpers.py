"""Tests for device binding, rate limiting, and phone normalisation."""

from datetime import datetime, timedelta, timezone

from app.auth.device import device_fingerprint_hash, evaluate_device_change
from app.auth.phone import normalise_phone
from app.auth.rate_limit import evaluate_rate_limit


# ─── Device binding ──────────────────────────────────────────────────────────


def test_fingerprint_hash_is_stable_and_64_chars():
    h1 = device_fingerprint_hash("device-uuid-1")
    h2 = device_fingerprint_hash("device-uuid-1")
    assert h1 == h2
    assert len(h1) == 64
    assert h1 != device_fingerprint_hash("device-uuid-2")


def test_first_login_binds_the_device():
    d = evaluate_device_change(stored_hash=None, presented_hash="x" * 64)
    assert d.allow is True
    assert d.reason == "first_login"


def test_same_device_allowed():
    d = evaluate_device_change(stored_hash="x" * 64, presented_hash="x" * 64)
    assert d.allow is True
    assert d.reason == "same_device"


def test_device_change_blocks():
    d = evaluate_device_change(stored_hash="x" * 64, presented_hash="y" * 64)
    assert d.allow is False
    assert d.reason == "device_change_required"


# ─── Rate limit ──────────────────────────────────────────────────────────────


def _t(seconds_ago: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)


def test_rate_limit_allows_first_request():
    d = evaluate_rate_limit(phone_request_times=[], ip_request_times=[])
    assert d.allow is True


def test_rate_limit_blocks_per_phone_at_limit():
    times = [_t(60), _t(120), _t(180)]
    d = evaluate_rate_limit(
        phone_request_times=times, ip_request_times=[], phone_max=3
    )
    assert d.allow is False
    assert d.reason == "phone_throttled"
    assert d.retry_after_seconds > 0


def test_rate_limit_ignores_old_requests_outside_window():
    # 3 requests, but all older than 11 minutes - should not count.
    times = [_t(800), _t(900), _t(1000)]
    d = evaluate_rate_limit(
        phone_request_times=times, ip_request_times=[], phone_max=3,
        phone_window_seconds=600,
    )
    assert d.allow is True


def test_rate_limit_blocks_per_ip_at_limit():
    times = [_t(100) for _ in range(30)]
    d = evaluate_rate_limit(
        phone_request_times=[], ip_request_times=times, ip_max=30
    )
    assert d.allow is False
    assert d.reason == "ip_throttled"


# ─── Phone normalisation ─────────────────────────────────────────────────────


def test_phone_accepts_local_nigerian_format():
    assert normalise_phone("08035550101") == "+2348035550101"
    assert normalise_phone("0803 555 0101") == "+2348035550101"


def test_phone_accepts_e164():
    assert normalise_phone("+2348035550101") == "+2348035550101"


def test_phone_rejects_garbage():
    try:
        normalise_phone("not-a-phone")
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_phone_rejects_too_short():
    try:
        normalise_phone("123")
    except ValueError:
        return
    raise AssertionError("expected ValueError")
