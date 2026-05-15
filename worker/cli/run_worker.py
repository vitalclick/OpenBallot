"""Background worker entrypoint.

Run with:
  python -m worker.cli.run_worker

Or inside docker:
  docker compose -f infra/docker-compose.prod.yml run worker python -m worker.cli.run_worker

The worker connects to Postgres + Redis, instantiates the extractor +
anomaly engine once, and pumps jobs off the Redis list. Graceful
shutdown on SIGTERM (used by Docker / Kubernetes) - the BRPOP timeout
is short so the worker drains in at most that many seconds.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from app.config import settings
from app.db import close_pool, init_pool
from app.jobs.ingest import IngestionJobHandler
from app.jobs.publisher import EventPublisher
from app.jobs.queue import JobQueue

log = logging.getLogger(__name__)


async def main() -> None:
    logging.basicConfig(
        level=settings().log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log.info("worker.starting")

    await init_pool()
    queue = JobQueue.from_settings()
    publisher = EventPublisher.from_settings()
    handler = IngestionJobHandler(publisher=publisher)

    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info("worker.ready")

    while not stop.is_set():
        job = await queue.claim_blocking(timeout_seconds=5)
        if job is None:
            continue
        try:
            await handler.run(job)
            await queue.ack(job)
        except Exception:
            # The handler has already marked the row failed and published
            # the failure event. We do NOT nack/re-queue automatically -
            # transient failures are handled by an operator-triggered
            # retry endpoint. Auto-retry on extraction failures tends to
            # burn AI API budget on permanently bad inputs.
            await queue.ack(job)

    log.info("worker.draining")
    await close_pool()
    log.info("worker.stopped")


if __name__ == "__main__":
    asyncio.run(main())
