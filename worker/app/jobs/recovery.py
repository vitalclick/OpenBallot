"""Crashed-worker recovery.

Submissions that get stuck in processing_status='processing' for more
than `stale_threshold_seconds` mean a worker crashed mid-job. The
recovery cron:

  1. Finds those rows.
  2. Rebuilds an IngestionJob payload from the row.
  3. Resets processing_status -> 'queued' and clears
     extraction_started_at.
  4. Re-enqueues to Redis.

The recovery is idempotent in two senses:

  * Re-running picks up rows still stuck (a worker may have failed
    again on retry).
  * The job handler's writes are themselves idempotent thanks to
    UPSERT semantics on verified_results, ON CONFLICT DO NOTHING on
    audit_log, and the UNIQUE (election_id, pu_code, anomaly_type,
    submission_id) index on anomalies.

If a row has been stuck on `processing` for more than `give_up_seconds`
we mark it 'failed' with a recovery_giveup error rather than enqueuing
it again - typically these are submissions that hit a permanently bad
input (corrupt image, OCR misclassifying as not-an-EC8A) and would
just burn through API budget on infinite retry.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from ..db import pool
from .queue import IngestionJob, JobQueue

log = logging.getLogger(__name__)


DEFAULT_STALE_SECONDS = 30 * 60     # 30 minutes
DEFAULT_GIVE_UP_SECONDS = 4 * 60 * 60   # 4 hours


async def find_stale_processing(
    *, stale_seconds: int = DEFAULT_STALE_SECONDS
) -> list[dict[str, Any]]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, election_id, pu_code, image_url, image_sha256,
                   extraction_started_at, queued_at
              FROM ec8a_submissions
             WHERE processing_status = 'processing'
               AND extraction_started_at < NOW() - ($1 || ' seconds')::INTERVAL
            """,
            str(stale_seconds),
        )
        return [dict(r) for r in rows]


async def recover_one(
    queue: JobQueue,
    *,
    row: dict[str, Any],
    give_up_seconds: int = DEFAULT_GIVE_UP_SECONDS,
) -> str:
    """Re-queue or give up on a single stale row.

    Returns one of: 'requeued' | 'gave_up' | 'skipped'.
    """
    started_at: datetime | None = row.get("extraction_started_at")
    if started_at is None:
        return "skipped"

    age = (datetime.now(timezone.utc) - started_at).total_seconds()

    if age > give_up_seconds:
        async with pool().acquire() as conn:
            await conn.execute(
                """
                UPDATE ec8a_submissions
                   SET processing_status = 'failed',
                       processing_error = $1,
                       extraction_completed_at = NOW()
                 WHERE id = $2
                   AND processing_status = 'processing'
                """,
                f"recovery_giveup after {int(age)}s stuck in processing",
                row["id"],
            )
            await conn.execute(
                """
                INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
                VALUES ('submission.recovery_giveup', 'ec8a_submission', $1, $2::jsonb)
                """,
                str(row["id"]),
                f'{{"age_seconds": {int(age)}}}',
            )
        log.warning(
            "recovery.gave_up",
            extra={"submission_id": str(row["id"]), "age_seconds": int(age)},
        )
        return "gave_up"

    # Re-queue
    async with pool().acquire() as conn:
        # Guard the update so two recovery cron ticks running concurrently
        # don't both re-queue the same row.
        updated = await conn.execute(
            """
            UPDATE ec8a_submissions
               SET processing_status = 'queued',
                   extraction_started_at = NULL,
                   queued_at = NOW()
             WHERE id = $1
               AND processing_status = 'processing'
            """,
            row["id"],
        )
        if not updated.endswith("UPDATE 1"):
            return "skipped"
        await conn.execute(
            """
            INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
            VALUES ('submission.recovery_requeued', 'ec8a_submission', $1, $2::jsonb)
            """,
            str(row["id"]),
            f'{{"age_seconds": {int(age)}}}',
        )

    job = IngestionJob(
        submission_id=str(row["id"]),
        election_id=row["election_id"],
        pu_code=row["pu_code"],
        image_url=row["image_url"],
        image_sha256=row["image_sha256"],
        enqueued_at=datetime.now(timezone.utc).isoformat(),
    )
    await queue.enqueue(job)
    log.info(
        "recovery.requeued",
        extra={"submission_id": str(row["id"]), "age_seconds": int(age)},
    )
    return "requeued"


async def run_recovery(
    queue: JobQueue,
    *,
    stale_seconds: int = DEFAULT_STALE_SECONDS,
    give_up_seconds: int = DEFAULT_GIVE_UP_SECONDS,
) -> dict[str, int]:
    """One sweep. Returns counts: { requeued, gave_up, skipped }."""
    counts = {"requeued": 0, "gave_up": 0, "skipped": 0}
    rows = await find_stale_processing(stale_seconds=stale_seconds)
    for row in rows:
        outcome = await recover_one(queue, row=row, give_up_seconds=give_up_seconds)
        counts[outcome] += 1
    return counts
