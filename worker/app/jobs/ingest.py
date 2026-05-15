"""Ingestion job handler.

Runs the extraction + verification path for a single queued submission.
Idempotent under retry: re-running the same job re-extracts but does
not duplicate audit_log rows or anomaly rows (both use ON CONFLICT
DO NOTHING / UNIQUE constraints).

Stages
  1. Mark processing.
  2. Run extraction (Document AI primary, GPT-4o fallback - factory picks).
  3. UPDATE the submission row with extracted_data + per-field confidence.
  4. Recompute verified_results for the PU.
  5. Run inline sanity anomaly checks.
  6. Write audit_log 'submission.extracted' event.
  7. Publish to Redis channel for SSE.

On failure: mark `failed` with error text, publish the failure event,
let the worker decide whether to re-queue.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

from ..anomaly import AnomalyEngine
from ..config import settings
from ..db import pool
from ..extraction import build_engine
from ..models import (
    ExtractedEC8A,
    SubmissionRecord,
    SubmissionSource,
)
from ..verification import compute_consensus
from .publisher import EventPublisher
from .queue import IngestionJob

log = logging.getLogger(__name__)


class IngestionJobHandler:
    """The handler instance. Holds the extractor + anomaly engine so they
    are constructed once per worker process rather than per-job."""

    def __init__(
        self,
        publisher: EventPublisher | None = None,
        extractor=None,
        anomaly_engine: AnomalyEngine | None = None,
    ):
        self.publisher = publisher
        self.extractor = extractor or build_engine()
        self.anomaly = anomaly_engine or AnomalyEngine()

    async def run(self, job: IngestionJob) -> None:
        submission_id = UUID(job.submission_id)
        try:
            await self._mark_processing(submission_id)
            extraction = await self.extractor.run(job.image_url, job.pu_code)
            await self._mark_extracted(submission_id, extraction)
            verification_status = await self._recompute_verification(
                job.election_id, job.pu_code
            )
            anomaly_count = await self._run_sanity(
                extraction.extracted, job.election_id, submission_id
            )
            await self._audit_event(submission_id, job, extraction)

            if self.publisher:
                await self.publisher.submission_extracted(
                    submission_id=job.submission_id,
                    election_id=job.election_id,
                    pu_code=job.pu_code,
                    confidence=extraction.confidence_score,
                    anomaly_count=anomaly_count,
                )
                await self.publisher.verified_result(
                    election_id=job.election_id,
                    pu_code=job.pu_code,
                    status=verification_status,
                )
        except Exception as e:
            log.exception("ingest.job.failed", extra={"submission_id": job.submission_id})
            await self._mark_failed(submission_id, str(e))
            if self.publisher:
                await self.publisher.submission_failed(
                    submission_id=job.submission_id,
                    election_id=job.election_id,
                    pu_code=job.pu_code,
                    error=str(e),
                )
            raise

    # ─── DB writes ──────────────────────────────────────────────────────

    async def _mark_processing(self, submission_id: UUID) -> None:
        async with pool().acquire() as conn:
            await conn.execute(
                """
                UPDATE ec8a_submissions
                   SET processing_status = 'processing',
                       extraction_started_at = NOW()
                 WHERE id = $1
                """,
                submission_id,
            )

    async def _mark_extracted(self, submission_id: UUID, extraction) -> None:
        async with pool().acquire() as conn:
            await conn.execute(
                """
                UPDATE ec8a_submissions
                   SET processing_status = 'extracted',
                       extraction_completed_at = NOW(),
                       confidence_score = $1,
                       extracted_data = $2::jsonb,
                       per_field_confidence = $3::jsonb,
                       review_status = $4
                 WHERE id = $5
                """,
                extraction.confidence_score,
                extraction.extracted.model_dump_json(),
                json.dumps(extraction.per_field_confidence),
                "auto_approved"
                if (
                    extraction.confidence_score >= settings().extraction_confidence_floor
                    and extraction.arithmetic.consistent
                )
                else "pending_review",
                submission_id,
            )

    async def _mark_failed(self, submission_id: UUID, error: str) -> None:
        async with pool().acquire() as conn:
            await conn.execute(
                """
                UPDATE ec8a_submissions
                   SET processing_status = 'failed',
                       processing_error = $1,
                       extraction_completed_at = NOW()
                 WHERE id = $2
                """,
                error[:2000],
                submission_id,
            )

    async def _audit_event(self, submission_id: UUID, job: IngestionJob, extraction) -> None:
        async with pool().acquire() as conn:
            await conn.execute(
                """
                INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
                VALUES ('submission.extracted', 'ec8a_submission', $1, $2::jsonb)
                """,
                str(submission_id),
                json.dumps(
                    {
                        "election_id": job.election_id,
                        "pu_code": job.pu_code,
                        "image_sha256": job.image_sha256,
                        "confidence": extraction.confidence_score,
                        "backend": extraction.backend_used,
                        "arithmetic_ok": extraction.arithmetic.consistent,
                    }
                ),
            )

    # ─── Side effects (recompute + anomalies) ────────────────────────

    async def _recompute_verification(self, election_id: str, pu_code: str) -> str:
        async with pool().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, source_type, party_code, image_url, image_sha256,
                       extracted_data, submitted_at, confidence_score,
                       validation_flags, review_status
                  FROM ec8a_submissions
                 WHERE election_id = $1 AND pu_code = $2
                   AND processing_status = 'extracted'
                   AND review_status IN ('auto_approved', 'reviewed_accepted')
                """,
                election_id,
                pu_code,
            )

            submissions = [
                SubmissionRecord(
                    id=r["id"],
                    election_id=election_id,
                    pu_code=pu_code,
                    source_type=SubmissionSource(r["source_type"]),
                    party_code=r["party_code"],
                    image_url=r["image_url"],
                    image_sha256=r["image_sha256"],
                    gps=None,
                    submitted_at=r["submitted_at"],
                    confidence_score=float(r["confidence_score"] or 0),
                    extracted_data=ExtractedEC8A.model_validate_json(r["extracted_data"])
                    if isinstance(r["extracted_data"], str)
                    else ExtractedEC8A.model_validate(r["extracted_data"]),
                    validation_flags=r["validation_flags"] or {},
                    review_status=r["review_status"],
                )
                for r in rows
            ]
            outcome = compute_consensus(
                submissions, election_id=election_id, pu_code=pu_code
            )
            await conn.execute(
                """
                INSERT INTO verified_results (
                  election_id, pu_code, status, consensus_data,
                  submission_count, source_count, computed_at
                ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
                ON CONFLICT (election_id, pu_code) DO UPDATE
                  SET status = EXCLUDED.status,
                      consensus_data = EXCLUDED.consensus_data,
                      submission_count = EXCLUDED.submission_count,
                      source_count = EXCLUDED.source_count,
                      computed_at = EXCLUDED.computed_at
                """,
                election_id,
                pu_code,
                outcome.status.value,
                outcome.consensus_data.model_dump_json() if outcome.consensus_data else None,
                outcome.submission_count,
                outcome.source_count,
            )
        return outcome.status.value

    async def _run_sanity(
        self, extracted: ExtractedEC8A, election_id: str, submission_id: UUID
    ) -> int:
        hits = await self.anomaly.run_inline_sanity(
            extracted=extracted,
            election_id=election_id,
            submission_id=submission_id,
        )
        return len(hits)
