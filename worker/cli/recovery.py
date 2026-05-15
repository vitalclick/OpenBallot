"""Recovery cron entrypoint.

Run with:
  python -m cli.recovery
Or in cron:
  */5 * * * * python -m cli.recovery

Walks any submission stuck in processing_status='processing' for >30
min, re-queues to Redis; submissions stuck >4 hours are marked failed
with a recovery_giveup audit event so they don't pile up forever.
"""

from __future__ import annotations

import asyncio
import logging

from app.config import settings
from app.db import close_pool, init_pool
from app.jobs.queue import JobQueue
from app.jobs.recovery import run_recovery
from app.observability import configure_logging, init_sentry

log = logging.getLogger(__name__)


async def main() -> None:
    configure_logging()
    init_sentry(environment=settings().environment)
    await init_pool()
    queue = JobQueue.from_settings()

    counts = await run_recovery(queue)
    log.info("recovery.complete", extra=counts)
    print(counts)

    await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
