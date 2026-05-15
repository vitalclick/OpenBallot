"""Redis-backed job queue.

The queue is a single Redis list per job type. Producers `LPUSH` JSON
payloads; consumers `BRPOP` them with a timeout so the worker can
gracefully shut down between deploys.

A second Redis structure tracks in-flight jobs - if a worker crashes
mid-job, the recovery cron rehydrates the submission row to
processing_status='queued' so another worker picks it up. We never
silently lose a submission.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from uuid import UUID

import redis.asyncio as aioredis

from ..config import settings


INGESTION_QUEUE = "openballot:jobs:ingest"
INFLIGHT_HASH = "openballot:jobs:inflight"


@dataclass
class IngestionJob:
    """Wire payload for an extraction job.

    Carries the submission row's primary key plus the bits we need to
    run extraction without re-reading from the DB. The actual image
    bytes are NOT in here - the extractor fetches them from object
    storage via image_url.
    """

    submission_id: str
    election_id: str
    pu_code: str
    image_url: str
    image_sha256: str
    enqueued_at: str

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_json(cls, raw: str) -> "IngestionJob":
        return cls(**json.loads(raw))


class JobQueue:
    """Thin async wrapper around Redis lists.

    Held as a singleton in app state; tests instantiate one directly
    pointing at a fakeredis instance.
    """

    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    @classmethod
    def from_settings(cls) -> "JobQueue":
        r = aioredis.from_url(settings().redis_url, decode_responses=True)
        return cls(r)

    async def enqueue(self, job: IngestionJob, queue: str = INGESTION_QUEUE) -> None:
        await self.redis.lpush(queue, job.to_json())

    async def claim_blocking(
        self, queue: str = INGESTION_QUEUE, timeout_seconds: int = 5
    ) -> IngestionJob | None:
        # BRPOP returns (key, value) tuple; None on timeout.
        result = await self.redis.brpop(queue, timeout=timeout_seconds)
        if result is None:
            return None
        _, raw = result
        job = IngestionJob.from_json(raw)
        # Track as in-flight so a crashed worker can be reconciled.
        await self.redis.hset(INFLIGHT_HASH, job.submission_id, raw)
        return job

    async def ack(self, job: IngestionJob) -> None:
        await self.redis.hdel(INFLIGHT_HASH, job.submission_id)

    async def nack(self, job: IngestionJob) -> None:
        """Return a job to the queue for retry. Used by the worker when
        an extraction fails with a transient error. The submission row
        keeps its `failed` status with an error message until the
        retry succeeds."""
        await self.redis.hdel(INFLIGHT_HASH, job.submission_id)
        await self.redis.lpush(INGESTION_QUEUE, job.to_json())

    async def depth(self, queue: str = INGESTION_QUEUE) -> int:
        return int(await self.redis.llen(queue))

    async def inflight_count(self) -> int:
        return int(await self.redis.hlen(INFLIGHT_HASH))


# ─── Convenience producer used by the FastAPI handler ───────────────────────


async def enqueue_ingestion(
    queue: JobQueue,
    *,
    submission_id: UUID,
    election_id: str,
    pu_code: str,
    image_url: str,
    image_sha256: str,
) -> None:
    job = IngestionJob(
        submission_id=str(submission_id),
        election_id=election_id,
        pu_code=pu_code,
        image_url=image_url,
        image_sha256=image_sha256,
        enqueued_at=datetime.now(timezone.utc).isoformat(),
    )
    await queue.enqueue(job)


# Singleton used by the FastAPI app. Tests do not import this; they
# construct a JobQueue directly.
_singleton: JobQueue | None = None


async def get_queue() -> JobQueue:
    global _singleton
    if _singleton is None:
        _singleton = JobQueue.from_settings()
    return _singleton


async def close_queue() -> None:
    global _singleton
    if _singleton is not None:
        await _singleton.redis.aclose()
        _singleton = None
