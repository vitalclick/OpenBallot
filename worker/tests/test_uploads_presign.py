"""Tests for the presigned-upload endpoint.

We mock boto3's S3 client so the tests are hermetic. The endpoint's
authorisation rules are the interesting part - we exercise every
role-based + assignment-based branch.
"""

from __future__ import annotations

from datetime import UTC
from unittest.mock import patch

import pytest

from app.auth.jwt_tokens import AgentClaims
from app.uploads.router import PresignIn, presign
from app.uploads.s3_client import PresignResult


def _claims(
    role: str = "party_agent",
    pu: str | None = "25-11-04-007",
    party: str | None = "APC",
) -> AgentClaims:
    from datetime import datetime, timedelta

    now = datetime.now(UTC)
    return AgentClaims(
        sub="11111111-1111-1111-1111-111111111111",
        role=role,
        party=party,
        pu=pu,
        dev="d" * 64,
        iat=now,
        exp=now + timedelta(hours=1),
    )


def _payload(**overrides) -> PresignIn:
    base = {
        "election_id": "2027-presidential",
        "pu_code": "25-11-04-007",
        "content_type": "image/jpeg",
        "content_length": 800_000,
        "sha256": "a" * 64,
    }
    base.update(overrides)
    return PresignIn(**base)


def _stub_presigner(*, object_key=None, **_):
    return PresignResult(
        upload_url=f"https://storage.test/PUT/{object_key}?sig=x",
        object_key=object_key or "stub",
        public_url=f"https://evidence.openballot.ng/{object_key}",
        expires_in_seconds=300,
    )


@pytest.mark.asyncio
async def test_party_agent_can_presign_for_their_pu():
    with patch("app.uploads.router.s3_client.generate_upload_url",
               side_effect=_stub_presigner):
        out = await presign(_payload(), _claims())
    assert out.upload_url.startswith("https://storage.test/")
    assert out.image_url.startswith("https://evidence.openballot.ng/")
    assert "2027-presidential" in out.object_key
    assert "25-11-04-007" in out.object_key
    # Per-install uuid is at the leaf; key must end with the right extension
    assert out.object_key.endswith(".jpg")


@pytest.mark.asyncio
async def test_party_agent_cannot_presign_for_different_pu():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ex:
        await presign(_payload(pu_code="33-15-05-001"), _claims(pu="25-11-04-007"))
    assert ex.value.status_code == 403
    assert ex.value.detail["code"] == "pu_mismatch"


@pytest.mark.asyncio
async def test_observer_can_presign_for_any_pu():
    with patch("app.uploads.router.s3_client.generate_upload_url",
               side_effect=_stub_presigner):
        out = await presign(
            _payload(pu_code="33-15-05-001"),
            _claims(role="observer", pu=None, party=None),
        )
    assert "33-15-05-001" in out.object_key


@pytest.mark.asyncio
async def test_party_admin_cannot_presign():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ex:
        await presign(_payload(), _claims(role="party_admin", pu=None))
    assert ex.value.status_code == 403
    assert ex.value.detail["code"] == "role_cannot_submit"


@pytest.mark.asyncio
async def test_consortium_reviewer_cannot_presign():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ex:
        await presign(_payload(), _claims(role="consortium_reviewer", pu=None, party=None))
    assert ex.value.status_code == 403


@pytest.mark.asyncio
async def test_oversize_image_rejected():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ex:
        await presign(_payload(content_length=20_000_000), _claims())
    assert ex.value.status_code == 413
    assert ex.value.detail["code"] == "image_too_large"


@pytest.mark.asyncio
async def test_undersize_image_rejected():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ex:
        await presign(_payload(content_length=1000), _claims())
    assert ex.value.status_code == 400
    assert ex.value.detail["code"] == "image_too_small"


@pytest.mark.asyncio
async def test_malformed_sha256_rejected():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ex:
        # Pydantic validates length; we have to bypass that to test the
        # hex-only regex check inside the handler.
        bad_payload = _payload(sha256="X" * 64)
        await presign(bad_payload, _claims())
    assert ex.value.status_code == 400
    assert ex.value.detail["code"] == "bad_sha256"


@pytest.mark.asyncio
async def test_object_key_encodes_agent_id_for_isolation():
    """Two agents requesting URLs for the same PU + election must get
    distinct object keys so a malicious party admin who steals an agent's
    token cannot overwrite their submission."""
    with patch("app.uploads.router.s3_client.generate_upload_url",
               side_effect=_stub_presigner):
        a = await presign(_payload(), _claims())
        b = await presign(
            _payload(),
            _claims(role="observer", pu=None, party=None),
        )
    assert a.object_key != b.object_key
    assert "11111111-1111-1111-1111-111111111111" in a.object_key
