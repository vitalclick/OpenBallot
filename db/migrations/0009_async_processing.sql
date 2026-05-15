-- OpenBallot Nigeria - Migration 0009
-- Async processing lifecycle for ec8a_submissions.
--
-- Up to now /v1/ingest ran the entire extraction pipeline synchronously
-- and returned only after the row was fully populated. At election-day
-- scale (150 req/sec) that does not fit: Document AI + GPT-4o latency
-- (1-5 seconds) blocks the HTTP path and bloats p99.
--
-- This migration adds a separate lifecycle column so the row can be
-- inserted with processing_status='queued' the moment the request lands,
-- and the heavy work runs in a background worker that pulls jobs from
-- Redis. review_status (the human review queue) is unchanged and
-- orthogonal to processing_status.

BEGIN;

CREATE TYPE processing_status AS ENUM (
  'queued',      -- accepted by /v1/ingest, awaiting extraction
  'processing',  -- a worker has claimed the job
  'extracted',   -- extraction succeeded; row is fully populated
  'failed'       -- extraction failed; processing_error has the reason
);

ALTER TABLE ec8a_submissions
  ADD COLUMN IF NOT EXISTS processing_status processing_status NOT NULL DEFAULT 'extracted',
  ADD COLUMN IF NOT EXISTS processing_error TEXT,
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_completed_at TIMESTAMPTZ;

-- Some fields are populated only after extraction completes; relax the
-- not-null constraints so the row can be inserted with placeholders at
-- queue time. We keep the constraint shape check loose for queued rows:
-- the check_extracted_shape constraint stays NOT VALID at queue time
-- and is only enforced when the job runs.
ALTER TABLE ec8a_submissions
  ALTER COLUMN extracted_data DROP NOT NULL;

ALTER TABLE ec8a_submissions
  DROP CONSTRAINT IF EXISTS chk_extracted_shape;

ALTER TABLE ec8a_submissions
  ADD CONSTRAINT chk_extracted_shape CHECK (
    processing_status <> 'extracted'
    OR (extracted_data IS NOT NULL
        AND extracted_data ? 'candidate_votes'
        AND extracted_data ? 'total_valid_votes')
  );

CREATE INDEX IF NOT EXISTS idx_sub_processing
  ON ec8a_submissions (processing_status, queued_at)
  WHERE processing_status IN ('queued', 'processing');

COMMIT;
