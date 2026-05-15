"""Anomaly statistical + historical sweep cron entrypoint.

Run with:
  python -m cli.anomaly_sweep                       # default election
  python -m cli.anomaly_sweep --election 2027-presidential

Layer 1 (sanity) runs inline on every /v1/ingest, so it does not need
a cron. Layers 2 (statistical peer outlier) and 3 (historical
baseline) require pooled data to be useful; they run here as a batch
sweep on a fixed cadence (default: hourly between elections, every
15 min during peak).

Both sweeps are idempotent thanks to the
UNIQUE(election_id, pu_code, anomaly_type, submission_id) constraint
on the anomalies table.
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from app.anomaly import AnomalyEngine
from app.config import settings
from app.db import close_pool, init_pool, pool
from app.observability import configure_logging, init_sentry

log = logging.getLogger(__name__)


async def main() -> None:
    configure_logging()
    init_sentry(environment=settings().environment)

    parser = argparse.ArgumentParser()
    parser.add_argument("--election", default="2027-presidential")
    parser.add_argument(
        "--skip-baselines",
        action="store_true",
        help="Skip refresh_anomaly_baselines() (saves time when the views"
             " are known to be fresh).",
    )
    args = parser.parse_args()

    await init_pool()
    engine = AnomalyEngine()

    if not args.skip_baselines:
        async with pool().acquire() as conn:
            await conn.execute("SELECT refresh_anomaly_baselines()")
        log.info("anomaly.baselines_refreshed")

    stat_inserted = await engine.run_statistical_sweep(args.election)
    hist_inserted = await engine.run_historical_sweep(args.election)
    result = {
        "election_id": args.election,
        "statistical_inserted": stat_inserted,
        "historical_inserted": hist_inserted,
    }
    log.info("anomaly.sweep.complete", extra=result)
    print(result)

    await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
