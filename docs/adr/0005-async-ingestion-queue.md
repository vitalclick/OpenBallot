# ADR-0005: Async ingestion via Redis-backed job queue

- **Status**: Accepted
- **Date**: 2026-03-10
- **Deciders**: Technical lead

## Context

`/v1/ingest` initially ran the entire extraction pipeline
synchronously inside the HTTP request: receive payload → validate →
extract (Document AI + GPT-4o) → persist → verify → audit. Document
AI alone is 1–5 seconds; under election-day load this blocks the
worker's HTTP slots and saturates at well below the documented 150
submissions/sec target.

## Decision

**`/v1/ingest` returns HTTP 202 in milliseconds after writing the
submission row in `processing_status='queued'`.** A separate worker
process pulls jobs off a Redis list and runs extraction +
verification + anomaly checks asynchronously. The PWA polls
`/v1/submissions/{id}` (or subscribes to the SSE stream) for the
final state.

We considered RQ and other Python job frameworks but settled on a
custom asyncio-native consumer (BRPOP loop, in-flight tracking via a
separate Redis hash). RQ's worker model is synchronous and our hot
path is async (asyncpg + httpx); fighting that produced more code
than writing the consumer directly.

## Alternatives considered

- **Stay synchronous**: rejected by the 150 req/sec target.
- **RQ (the Redis-Queue Python lib)**: rejected for the sync-vs-async
  mismatch above.
- **Celery**: rejected as too heavyweight for our needs;
  configuration surface is large; debugging is hard.
- **AWS SQS or GCP Pub/Sub**: rejected to keep the production stack
  reproducible without depending on a hyperscaler. Redis is already
  in the stack; using it twice (queue + pub/sub) is fine.

## Consequences

**Easy**: the HTTP path is bounded by Redis LPUSH, ~milliseconds.
Worker scaling is independent of HTTP scaling - run 2 workers when
quiet, 8 during election peak.

**Hard**: we now have a queue to monitor and a recovery story to
build (a crashed worker leaves submissions stuck in
`processing_status='processing'`). The recovery cron in
`worker/app/jobs/recovery.py` rehydrates those.

**Locked-in**: the database is the source of truth, not the queue.
A submission row is persisted BEFORE enqueueing. If Redis is wiped,
no submissions are lost - the recovery cron picks them up by
querying processing_status='queued'.

## References

- `worker/app/jobs/queue.py` - the Redis client + IngestionJob shape
- `worker/app/jobs/ingest.py` - the handler
- `worker/cli/run_worker.py` - the consumer entrypoint
- `worker/app/jobs/recovery.py` - crashed-worker recovery
