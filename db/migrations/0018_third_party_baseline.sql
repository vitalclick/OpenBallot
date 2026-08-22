-- OpenBallot Nigeria - Migration 0018
-- Third-party extracted results, and the anomaly they surface.
--
-- Context (issue #67): app/anomaly/historical.py compares each PU's result to
-- the same PU's 2023 figure, but no 2023 per-PU baseline exists. INEC's IReV
-- API does not serve the 2023 presidential election at all (0 presidential
-- rows; see scrapers/irev-results/README.md), and the INEC report carries the
-- presidential tally only at national level. So Layer 3 of a three-layer
-- anomaly engine has had nothing to run against since it was written.
--
-- A third party extracted those results from the EC8A scans. Loading them
-- turns the layer on, but they are not INEC's numbers and must never be
-- presented as though they were.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- A verification status for results nobody official published
-- ────────────────────────────────────────────────────────────────────────────
--
-- Distinct from the neighbouring states, and the distinction is the point:
--
--   * inec_published - INEC published this result themselves. A claim we
--                      cannot make here.
--   * single_source  - one party agent or observer reported it to us.
--   * consensus      - independent sources agreed.
--
-- third_party_extraction says: this figure was read off a scanned form by
-- someone outside both INEC and this platform, at a known and imperfect
-- accuracy. It is evidence and a baseline, not a result.

ALTER TYPE verification_status ADD VALUE IF NOT EXISTS 'third_party_extraction';

-- ────────────────────────────────────────────────────────────────────────────
-- Votes recorded against zero synced accreditation
-- ────────────────────────────────────────────────────────────────────────────
--
-- Separate from turnout_exceeds_accreditation, which compares two positive
-- numbers. This fires when accreditation reads exactly zero while votes were
-- recorded -- the signal the CCIJ investigation was built on, from BVAS
-- "synced accreditation" figures.
--
-- Deliberately NOT treated as equivalent to over-voting. A zero is ambiguous:
-- it can mean accreditation never happened, or that the BVAS device failed to
-- sync over a poor network. CCIJ sent journalists to the largest-disparity
-- locations (Oru East in Imo, Zaki in Bauchi) precisely because the data alone
-- could not settle it. The severity assigned in app/anomaly/sanity.py reflects
-- that ambiguity.

ALTER TYPE anomaly_type ADD VALUE IF NOT EXISTS 'votes_without_accreditation';

-- ────────────────────────────────────────────────────────────────────────────
-- Provenance on verified_results
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE verified_results
  ADD COLUMN source                TEXT,
  ADD COLUMN extraction_confidence NUMERIC(4, 3);

COMMENT ON COLUMN verified_results.source IS
  'Where this result came from when it did not arise from our own consensus
   engine, e.g. ''ccij_2023''. NULL for results this platform computed.';

COMMENT ON COLUMN verified_results.extraction_confidence IS
  'Confidence in the extraction, 0-1, when the source reports one. For a
   bulk third-party load this is the source''s measured accuracy, not a
   per-row score, and should be read as such.';

CREATE INDEX idx_vr_source ON verified_results (election_id, source)
  WHERE source IS NOT NULL;

COMMIT;
