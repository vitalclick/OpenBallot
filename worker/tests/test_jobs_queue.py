"""Tests for the job queue.

Uses an in-process FakeRedis so the tests are hermetic and fast - no
external Redis required.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.jobs.queue import (
    IngestionJob,
    JobQueue,
    enqueue_ingestion,
)


class FakeRedis:
    """Bare-minimum async fake. Supports lpush, brpop, llen, hset, hdel, hlen."""

    def __init__(self):
        self.lists: dict[str, list[str]] = {}
        self.hashes: dict[str, dict[str, str]] = {}

    async def lpush(self, key: str, value: str) -> None:
        self.lists.setdefault(key, []).insert(0, value)

    async def brpop(self, key: str, timeout: int = 0):
        lst = self.lists.get(key, [])
        if not lst:
            return None
        return (key, lst.pop())

    async def llen(self, key: str) -> int:
        return len(self.lists.get(key, []))

    async def hset(self, key: str, field: str, value: str) -> None:
        self.hashes.setdefault(key, {})[field] = value

    async def hdel(self, key: str, field: str) -> None:
        self.hashes.get(key, {}).pop(field, None)

    async def hlen(self, key: str) -> int:
        return len(self.hashes.get(key, {}))

    async def aclose(self) -> None:
        pass


@pytest.fixture
def queue():
    return JobQueue(FakeRedis())


def _job(sid: str = None) -> IngestionJob:
    return IngestionJob(
        submission_id=sid or str(uuid4()),
        election_id="2027-presidential",
        pu_code="25-11-04-007",
        image_url="https://x/y.jpg",
        image_sha256="a" * 64,
        enqueued_at=datetime.now(timezone.utc).isoformat(),
    )


@pytest.mark.asyncio
async def test_enqueue_increases_depth(queue):
    assert await queue.depth() == 0
    await queue.enqueue(_job())
    assert await queue.depth() == 1


@pytest.mark.asyncio
async def test_claim_blocking_returns_job_and_tracks_inflight(queue):
    job = _job()
    await queue.enqueue(job)
    claimed = await queue.claim_blocking()
    assert claimed is not None
    assert claimed.submission_id == job.submission_id
    assert claimed.pu_code == job.pu_code
    assert await queue.depth() == 0
    assert await queue.inflight_count() == 1


@pytest.mark.asyncio
async def test_ack_clears_inflight(queue):
    job = _job()
    await queue.enqueue(job)
    claimed = await queue.claim_blocking()
    await queue.ack(claimed)
    assert await queue.inflight_count() == 0


@pytest.mark.asyncio
async def test_nack_returns_job_to_queue(queue):
    job = _job()
    await queue.enqueue(job)
    claimed = await queue.claim_blocking()
    await queue.nack(claimed)
    assert await queue.depth() == 1
    assert await queue.inflight_count() == 0


@pytest.mark.asyncio
async def test_claim_returns_none_on_empty_queue(queue):
    result = await queue.claim_blocking(timeout_seconds=1)
    assert result is None


@pytest.mark.asyncio
async def test_enqueue_ingestion_helper_round_trips(queue):
    sid = uuid4()
    await enqueue_ingestion(
        queue,
        submission_id=sid,
        election_id="2027-presidential",
        pu_code="25-11-04-007",
        image_url="https://x/y.jpg",
        image_sha256="b" * 64,
    )
    claimed = await queue.claim_blocking()
    assert claimed.submission_id == str(sid)
    assert claimed.image_sha256 == "b" * 64


def test_ingestion_job_serialises_round_trip():
    job = _job()
    revived = IngestionJob.from_json(job.to_json())
    assert revived == job


def test_ingestion_job_payload_is_pure_json():
    """The serialised payload must be plain JSON so other languages (the
    Node web tier, an external auditor) can read it without pulling in
    a Python-specific format."""
    job = _job()
    parsed = json.loads(job.to_json())
    assert parsed["submission_id"] == job.submission_id
    assert parsed["election_id"] == job.election_id
