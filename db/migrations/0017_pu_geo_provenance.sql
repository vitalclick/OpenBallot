-- OpenBallot Nigeria - Migration 0017
-- Provenance and precision for polling-unit coordinates and voter counts.
--
-- Context (see issues #65, #66):
--   scripts/load_polling_units.py leaves `geog` and `registered_voters` NULL
--   because INEC's published roster carries neither. Enrichment therefore has
--   to come from a third party, and once it does, two facts about every
--   coordinate stop being self-evident:
--
--     1. WHERE it came from. A coordinate INEC never published must not be
--        indistinguishable from one it did. `geog_source` keeps that legible
--        in the registry rather than only in a loader's commit message.
--
--     2. HOW precise it is. Enrichment sources resolve co-located polling
--        units (several PUs in one school or market) to a single shared
--        point. Treating a shared point as an exact per-PU fix would make the
--        hard geofence reject legitimate submissions from dense urban PUs,
--        and `IngestionPipeline` has no recovery path for a hard reject --
--        the submission is refused outright. `geog_precision` lets the fence
--        degrade to a soft warning where the coordinate cannot bear the
--        weight of a hard decision.
--
-- Also adds `wards.source`, so the ward rows inserted to close the 2,671-PU /
-- 97-ward gap (#66) stay distinguishable from INEC-scraped wards. That the
-- gap exists at all is a finding worth keeping: INEC's own API returns zero
-- polling units for those wards (see Polling-Units/reconciliation/
-- RECONCILIATION-2023.md §8).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Polling-unit coordinate provenance
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE polling_units
  ADD COLUMN geog_source              TEXT,
  ADD COLUMN geog_precision           TEXT,
  ADD COLUMN registered_voters_source TEXT;

COMMENT ON COLUMN polling_units.geog_source IS
  'Provenance of geog, e.g. ''ccij_2023''. NULL when no coordinate is known.';

COMMENT ON COLUMN polling_units.geog_precision IS
  'exact       - coordinate is unique to this polling unit
   shared_site - coordinate is shared with other PUs at the same site;
                 usable for a soft fence, NOT for a hard reject
   approximate - coordinate is known to be ward- or site-level only';

COMMENT ON COLUMN polling_units.registered_voters_source IS
  'Provenance of registered_voters, e.g. ''ccij_2023''.';

-- A coordinate without provenance is not auditable, and one without a stated
-- precision would be read as exact by default -- the failure mode that
-- rejects real submissions. Require both whenever geog is set.
ALTER TABLE polling_units
  ADD CONSTRAINT ck_pu_geog_provenance CHECK (
    geog IS NULL
    OR (geog_source IS NOT NULL AND geog_precision IS NOT NULL)
  );

ALTER TABLE polling_units
  ADD CONSTRAINT ck_pu_geog_precision CHECK (
    geog_precision IS NULL
    OR geog_precision IN ('exact', 'shared_site', 'approximate')
  );

-- The ingestion path reads precision on every GPS-bearing submission.
CREATE INDEX idx_pu_geog_precision ON polling_units (geog_precision)
  WHERE geog IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- Ward provenance
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE wards
  ADD COLUMN source TEXT NOT NULL DEFAULT 'inec_scrape';

COMMENT ON COLUMN wards.source IS
  'inec_scrape - enumerated by Polling-Units/scraper.js from INEC
   ccij_2023   - present in the CCIJ 2023 roster but absent from INEC''s API';

COMMIT;
