"""FastAPI entrypoint for the worker service.

Endpoints:
  POST /v1/ingest                - PWA upload callback
  POST /v1/verify/{election}/{pu} - manually trigger consensus recomputation
  GET  /v1/health                 - liveness
  GET  /v1/audit/verify           - run the chain verifier on the last N events

The ingestion endpoint runs synchronously through the pipeline + extraction
in dev, and enqueues to RQ in production. The protocol is identical from the
caller's perspective.
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .audit import cron as anchor_cron
from .audit.chain import AuditEvent, verify_chain
from .audit.ethereum_client import build_from_settings as build_eth_client
from .auth.router import router as auth_router
from .admin.router import router as admin_router
from .anomaly import AnomalyEngine
from .observers import observer_router
from .uploads import uploads_router
from .config import settings
from .db import close_pool, init_pool, pool
from .extraction import build_engine
from .ingestion import IngestionPipeline
from .jobs import enqueue_ingestion
from .jobs.queue import close_queue, get_queue
from .ingestion.pipeline import IngestionContext
from .models import IngestionPayload
from .observability import (
    INFLIGHT_GAUGE,
    INGESTION_COUNTER,
    INGESTION_REJECTED_COUNTER,
    QUEUE_DEPTH_GAUGE,
    configure_logging,
    init_sentry,
    metrics_response,
)

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    init_sentry(environment=settings().environment)
    await init_pool()
    await get_queue()       # prime the Redis connection for /v1/ingest
    log.info("worker.startup", extra={"env": settings().environment})
    yield
    await close_queue()
    await close_pool()


app = FastAPI(
    title="OpenBallot Nigeria - Worker",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(observer_router)
app.include_router(uploads_router)

_pipeline = IngestionPipeline()
# The factory picks Document AI + GPT-4o adapters when credentials are
# configured; otherwise it returns paired stubs. Either way the engine's
# protocol is identical from the ingest endpoint's perspective.
_extractor = build_engine()
_anomaly = AnomalyEngine()


@app.get("/v1/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "env": settings().environment}


@app.get("/metrics")
async def metrics():
    """Prometheus scrape endpoint. Returns text-format metrics.
    Public on the application network; restrict at the load balancer
    or via firewall if you don't want operational metrics exposed.

    Refreshes the queue-depth + in-flight gauges from Redis at scrape
    time so the dashboard reflects current state."""
    try:
        queue = await get_queue()
        QUEUE_DEPTH_GAUGE.set(await queue.depth())
        INFLIGHT_GAUGE.set(await queue.inflight_count())
    except Exception:
        # Metric refresh failure must not block the scrape.
        pass
    return metrics_response()


@app.post("/v1/ingest")
async def ingest(payload: IngestionPayload) -> dict:
    s = settings()
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng
            FROM polling_units WHERE pu_code = $1
            """,
            payload.pu_code,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="unknown polling unit")

        existing = False
        if payload.party_code:
            existing = await conn.fetchval(
                """
                SELECT EXISTS (
                  SELECT 1 FROM ec8a_submissions
                  WHERE election_id = $1 AND pu_code = $2 AND party_code = $3
                    AND source_type = 'party_agent'
                )
                """,
                payload.election_id,
                payload.pu_code,
                payload.party_code,
            )

        election_date = await conn.fetchval(
            "SELECT election_date FROM elections WHERE id = $1", payload.election_id
        )

    ctx = IngestionContext(
        pu_lat=row["lat"],
        pu_lng=row["lng"],
        election_date=election_date,
        min_image_bytes=s.min_image_bytes,
        max_image_bytes=s.max_image_bytes,
        gps_soft_metres=s.gps_geofence_metres,
        gps_hard_metres=s.gps_hard_block_metres,
        existing_party_submission=bool(existing),
    )
    result = _pipeline.run(payload, ctx)

    if not result.accepted:
        reason = next(iter(result.flags), result.rejected_reason or "unknown")
        INGESTION_REJECTED_COUNTER.labels(reason=reason).inc()
        return {
            "accepted": False,
            "submission_id": str(result.submission_id),
            "reason": result.rejected_reason,
            "flags": result.flags,
        }

    INGESTION_COUNTER.labels(source_type=payload.source_type.value).inc()

    # Async ingestion: persist the submission row with processing_status
    # 'queued' immediately, then enqueue a background job that runs the
    # heavy extraction + verification + anomaly + audit work. The HTTP
    # path returns 202 in milliseconds. The PWA polls /v1/submissions/{id}
    # or subscribes to the SSE event stream for the final state.
    async with pool().acquire() as conn:
        await conn.execute(
            """
            INSERT INTO ec8a_submissions (
              id, election_id, pu_code, source_type, party_code,
              image_url, image_sha256, image_bytes, exif_metadata,
              gps_lat, gps_lng, gps_distance_metres, captured_at,
              validation_flags, review_status,
              processing_status, queued_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,
                      $14::jsonb,$15,'queued',NOW())
            """,
            result.submission_id,
            payload.election_id,
            payload.pu_code,
            payload.source_type.value,
            payload.party_code,
            payload.image_url,
            payload.image_sha256,
            payload.image_bytes,
            payload.exif_metadata,
            payload.gps.lat if payload.gps else None,
            payload.gps.lng if payload.gps else None,
            result.distance_metres,
            payload.captured_at,
            result.flags,
            "pending_review",
        )
        await conn.execute(
            """
            INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
            VALUES ('submission.created', 'ec8a_submission', $1, $2::jsonb)
            """,
            str(result.submission_id),
            json.dumps({
                "election_id": payload.election_id,
                "pu_code": payload.pu_code,
                "image_sha256": payload.image_sha256,
                "source": payload.source_type.value,
                "party": payload.party_code,
            }),
        )

    queue = await get_queue()
    await enqueue_ingestion(
        queue,
        submission_id=result.submission_id,
        election_id=payload.election_id,
        pu_code=payload.pu_code,
        image_url=payload.image_url,
        image_sha256=payload.image_sha256,
    )

    return JSONResponse(
        status_code=202,
        content={
            "accepted": True,
            "submission_id": str(result.submission_id),
            "processing_status": "queued",
            "flags": result.flags,
            "poll_url": f"/v1/submissions/{result.submission_id}",
        },
    )


@app.get("/v1/submissions/{submission_id}")
async def get_submission_status(submission_id: str) -> dict:
    """Poll the lifecycle state of a submission. Used by the PWA between
    upload and the final extraction state; also exposed publicly so any
    client can confirm a submission landed.
    """
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, election_id, pu_code, source_type, party_code,
                   image_url, image_sha256, processing_status, processing_error,
                   queued_at, extraction_started_at, extraction_completed_at,
                   confidence_score, review_status
              FROM ec8a_submissions
             WHERE id = $1
            """,
            submission_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        return {
            "id": str(row["id"]),
            "election_id": row["election_id"],
            "pu_code": row["pu_code"],
            "processing_status": row["processing_status"],
            "processing_error": row["processing_error"],
            "review_status": row["review_status"],
            "confidence_score": float(row["confidence_score"]) if row["confidence_score"] else None,
            "queued_at": row["queued_at"].isoformat() if row["queued_at"] else None,
            "extraction_started_at": row["extraction_started_at"].isoformat() if row["extraction_started_at"] else None,
            "extraction_completed_at": row["extraction_completed_at"].isoformat() if row["extraction_completed_at"] else None,
        }


@app.post("/v1/submissions/{submission_id}/retry")
async def retry_submission(submission_id: str) -> dict:
    """Operator-triggered retry for a failed submission.

    Only submissions in processing_status='failed' are eligible - we do
    not re-queue successful or pending rows. Resets the row to 'queued'
    + clears processing_error + re-enqueues to Redis. Writes an
    audit_log 'submission.retry_requested' event so the retry is itself
    part of the chained record.
    """
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, election_id, pu_code, image_url, image_sha256,
                   processing_status, processing_error
              FROM ec8a_submissions
             WHERE id = $1
             FOR UPDATE
            """,
            submission_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        if row["processing_status"] != "failed":
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "not_failed",
                    "message": f"current status: {row['processing_status']}",
                },
            )
        await conn.execute(
            """
            UPDATE ec8a_submissions
               SET processing_status = 'queued',
                   processing_error = NULL,
                   extraction_started_at = NULL,
                   extraction_completed_at = NULL,
                   queued_at = NOW()
             WHERE id = $1
            """,
            submission_id,
        )
        await conn.execute(
            """
            INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
            VALUES ('submission.retry_requested', 'ec8a_submission', $1, $2::jsonb)
            """,
            str(submission_id),
            json.dumps({
                "previous_error": row["processing_error"],
                "election_id": row["election_id"],
                "pu_code": row["pu_code"],
            }),
        )

    queue = await get_queue()
    await enqueue_ingestion(
        queue,
        submission_id=row["id"],
        election_id=row["election_id"],
        pu_code=row["pu_code"],
        image_url=row["image_url"],
        image_sha256=row["image_sha256"],
    )
    return {"submission_id": submission_id, "processing_status": "queued"}


@app.get("/v1/audit/verify")
async def audit_verify(limit: int = 1000) -> dict:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT seq, event_type, entity_type, entity_id,
                   actor_id::text, event_at, event_data, prev_hash, log_hash
            FROM audit_log
            ORDER BY seq
            LIMIT $1
            """,
            limit,
        )
    events = [
        AuditEvent(
            seq=r["seq"],
            event_type=r["event_type"],
            entity_type=r["entity_type"],
            entity_id=r["entity_id"],
            actor_id=r["actor_id"],
            event_at=r["event_at"],
            event_data=r["event_data"],
            prev_hash=r["prev_hash"],
            log_hash=r["log_hash"],
        )
        for r in rows
    ]
    ok, broken = verify_chain(events)
    return {"ok": ok, "events_checked": len(events), "first_broken_seq": broken}


@app.post("/v1/anomaly/sweep")
async def anomaly_sweep(election_id: str = "2027-presidential") -> dict:
    """Run the batch anomaly sweep over an election.

    Refreshes the peer-distribution materialised views, then runs the
    statistical and historical detectors. Idempotent: re-runs only emit
    rows for newly-anomalous PUs (the table has a unique index on
    (election_id, pu_code, anomaly_type, submission_id)).
    """
    async with pool().acquire() as conn:
        await conn.execute("SELECT refresh_anomaly_baselines()")
    stat_inserted = await _anomaly.run_statistical_sweep(election_id)
    hist_inserted = await _anomaly.run_historical_sweep(election_id)
    return {
        "election_id": election_id,
        "statistical_inserted": stat_inserted,
        "historical_inserted": hist_inserted,
    }


@app.post("/v1/audit/anchor")
async def audit_anchor_run() -> dict:
    """Manual trigger for the anchor cron.

    Operator-callable so we have a 'kick the anchor' button when the
    scheduled cron run misses. Idempotent (see app.audit.cron docs).
    Returns 503 when anchoring is disabled or unconfigured.
    """
    client = build_eth_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail={"code": "anchor_disabled",
                    "message": "ANCHOR_ENABLED=false or RPC/key missing"},
        )
    result = await anchor_cron.run_once(client)
    return result
