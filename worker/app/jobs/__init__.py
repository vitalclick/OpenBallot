"""Background job runner.

The worker has two responsibilities:

  1. /v1/ingest validates the submission, persists it as `queued`, and
     enqueues a job. The HTTP path returns 202 immediately.
  2. A separate worker process pulls jobs from Redis and runs extraction,
     verification recomputation, sanity anomaly checks, and the
     audit-log event. It then publishes an SSE-bound update so the
     public map sees the change with sub-second latency.

We do NOT use RQ even though Redis + RQ are in pyproject. RQ's worker
model is synchronous and our worker has async I/O (asyncpg, httpx) on
every step of extraction. A custom asyncio-native consumer is simpler
and faster.
"""

from .queue import IngestionJob, JobQueue, enqueue_ingestion
from .publisher import EventPublisher

__all__ = ["IngestionJob", "JobQueue", "enqueue_ingestion", "EventPublisher"]
