"""Tests for agent JWT issuance and verification."""

import jwt as jwt_lib

from app.auth.jwt_tokens import issue_agent_token, verify_agent_token


SECRET = "test-secret-for-jwt"


def _issue(**overrides):
    base = dict(
        secret=SECRET,
        agent_id="11111111-1111-1111-1111-111111111111",
        role="party_agent",
        party="APC",
        pu_code="25-11-04-007",
        device_fingerprint_hash="d" * 64,
        ttl_seconds=60,
    )
    base.update(overrides)
    return issue_agent_token(**base)


def test_round_trip_recovers_all_claims():
    token = _issue()
    claims = verify_agent_token(token, SECRET)
    assert claims.sub == "11111111-1111-1111-1111-111111111111"
    assert claims.role == "party_agent"
    assert claims.party == "APC"
    assert claims.pu == "25-11-04-007"
    assert claims.dev == "d" * 64


def test_observer_token_has_no_party_or_pu():
    token = _issue(role="observer", party=None, pu_code=None)
    claims = verify_agent_token(token, SECRET)
    assert claims.party is None
    assert claims.pu is None
    assert claims.role == "observer"


def test_wrong_secret_rejects():
    token = _issue()
    try:
        verify_agent_token(token, "different-secret")
    except jwt_lib.InvalidTokenError:
        return
    raise AssertionError("expected verification to fail with wrong secret")


def test_expired_token_rejects():
    token = _issue(ttl_seconds=-1)
    try:
        verify_agent_token(token, SECRET)
    except jwt_lib.ExpiredSignatureError:
        return
    raise AssertionError("expected expired token to be rejected")


def test_tampered_token_rejects():
    token = _issue()
    parts = token.split(".")
    # Flip a single byte in the payload segment
    bad = parts[0] + "." + parts[1][:-1] + ("a" if parts[1][-1] != "a" else "b") + "." + parts[2]
    try:
        verify_agent_token(bad, SECRET)
    except jwt_lib.InvalidTokenError:
        return
    raise AssertionError("expected tampered token to be rejected")
