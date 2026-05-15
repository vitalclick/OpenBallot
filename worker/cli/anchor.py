"""Audit chain anchor cron entrypoint.

Run with:
  python -m cli.anchor                # one-shot
  while true; do python -m cli.anchor; sleep 1800; done    # production loop

Production compose runs this in a sleep loop with the cadence
documented in DEPLOYMENT_INFO.md (30 min between elections, 10 min
during peak). The interval is set in the compose service, not here,
so operators can dial it without rebuilding the image.

The cron is safe to over-run: pickup_batch + submit_pending are both
idempotent. Re-running every minute is fine (just wastes a few SQL
queries). Re-running every second would be wasteful but not harmful.
"""

from __future__ import annotations

import asyncio
import logging

from app.audit import cron as anchor_cron
from app.audit.ethereum_client import build_from_settings as build_eth_client
from app.config import settings
from app.db import close_pool, init_pool
from app.observability import configure_logging, init_sentry

log = logging.getLogger(__name__)


async def main() -> None:
    configure_logging()
    init_sentry(environment=settings().environment)
    await init_pool()

    client = build_eth_client()
    if client is None:
        log.warning("anchor.disabled", extra={"reason": "ANCHOR_ENABLED=false or RPC/key missing"})
        await close_pool()
        return

    result = await anchor_cron.run_once(client)
    log.info("anchor.run_once.complete", extra=result)
    print(result)
    await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
