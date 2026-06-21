-- OpenBallot Nigeria - Migration 0016
-- IReV per-PU catalog: a staging table for the "fetch + store scans"
-- (catalog-only) ingestion from INEC's IReV portal.
--
-- Why a staging table rather than ec8a_submissions directly:
--   * ec8a_submissions requires the EC8A image bytes (image_sha256 / image_bytes
--     are NOT NULL) and a pu_code that FKs to our polling_units registry. The
--     catalog pass records per-PU metadata + the EC8A image URL WITHOUT
--     downloading the image (INEC's CDN allowlists by host) and for elections
--     whose PUs may not be in our 2023 registry (e.g. 2026 by-elections).
--   * Keeping IReV's raw identifiers here decouples ingestion from the
--     evidentiary core. A later image+OCR pass promotes catalog rows into
--     ec8a_submissions (source_type='inec_irev') + verified_results
--     ('inec_published') once images and extracted tallies exist.
--
-- Written by scrapers/irev-results (node scrape.js --catalog-only). pu_code is
-- IReV's own slash form ("28/12/03/003"); pu_code_string is the digit form.

BEGIN;

CREATE TABLE irev_pu_catalog (
  irev_election_id    INTEGER NOT NULL,        -- IReV integer election_id (e.g. 5005)
  pu_code             TEXT NOT NULL,           -- IReV pu_code, slash form
  pu_code_string      TEXT,                    -- digit form ("281203003")
  pu_name             TEXT,
  polling_unit_id     BIGINT,                  -- IReV internal PU id
  election_label      TEXT,                    -- election full_name
  election_type_id    INTEGER,                 -- 1=Pres 2=Gov 3=Sen 4=Reps 5=Assembly 6=Chair 7=Councillor
  state_id            INTEGER,                 -- IReV internal state id (1..37)
  lga_name            TEXT,
  lga_code            TEXT,
  ward_name           TEXT,
  document_url        TEXT,                    -- EC8A scan URL; NULL if not yet uploaded
  document_size       BIGINT,
  is_zero_pu          BOOLEAN,
  result_updated_at   TIMESTAMPTZ,             -- IReV upload time for the EC8A
  irev_record_id      TEXT,                    -- Mongo _id of the result document
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw                 JSONB,                   -- full raw API entry, for forensics
  PRIMARY KEY (irev_election_id, pu_code)
);

-- Fast "how many PUs have an EC8A uploaded" per election.
CREATE INDEX idx_irev_catalog_uploaded ON irev_pu_catalog (irev_election_id)
  WHERE document_url IS NOT NULL;

-- Public read: IReV results are published, concluded, official data.
ALTER TABLE irev_pu_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY pub_read_irev_catalog ON irev_pu_catalog FOR SELECT USING (TRUE);

COMMIT;
