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

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from .audit.chain import AuditEvent, verify_chain
from .auth.router import router as auth_router
from .config import settings
from .db import close_pool, init_pool, pool
from .extraction import ExtractionEngine
from .extraction.engine import StubExtractor
from .ingestion import IngestionPipeline
from .ingestion.pipeline import IngestionContext
from .models import IngestionPayload

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=settings().log_level)
    await init_pool()
    log.info("worker.startup", extra={"env": settings().environment})
    yield
    await close_pool()


app = FastAPI(
    title="OpenBallot Nigeria - Worker",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
)
app.include_router(auth_router)

_pipeline = IngestionPipeline()
_extractor = ExtractionEngine(
    primary=StubExtractor(name="document-ai-stub", confidence=0.97),
    secondary=StubExtractor(name="gpt4o-vision-stub", confidence=0.92),
    confidence_floor=settings().extraction_confidence_floor,
)


@app.get("/v1/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "env": settings().environment}


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
        return {
            "accepted": False,
            "submission_id": str(result.submission_id),
            "reason": result.rejected_reason,
            "flags": result.flags,
        }

    extraction = await _extractor.run(payload.image_url, payload.pu_code)

    async with pool().acquire() as conn:
        await conn.execute(
            """
            INSERT INTO ec8a_submissions (
              id, election_id, pu_code, source_type, party_code,
              image_url, image_sha256, image_bytes, exif_metadata,
              gps_lat, gps_lng, gps_distance_metres, captured_at,
              confidence_score, extracted_data, per_field_confidence,
              validation_flags, review_status
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,
                      $14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
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
            extraction.confidence_score,
            extraction.extracted.model_dump_json(),
            extraction.per_field_confidence,
            result.flags,
            "auto_approved"
            if (
                extraction.confidence_score >= s.extraction_confidence_floor
                and extraction.arithmetic.consistent
            )
            else "pending_review",
        )

        await conn.execute(
            """
            INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
            VALUES ('submission.created', 'ec8a_submission', $1, $2::jsonb)
            """,
            str(result.submission_id),
            {
                "election_id": payload.election_id,
                "pu_code": payload.pu_code,
                "image_sha256": payload.image_sha256,
                "source": payload.source_type.value,
                "party": payload.party_code,
            },
        )

    return {
        "accepted": True,
        "submission_id": str(result.submission_id),
        "confidence": extraction.confidence_score,
        "arithmetic_consistent": extraction.arithmetic.consistent,
        "extractor": extraction.backend_used,
        "flags": result.flags,
    }


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
