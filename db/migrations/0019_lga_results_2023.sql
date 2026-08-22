-- OpenBallot Nigeria - Migration 0019
-- 2023 presidential results at LGA level (issue #73).
--
-- The missing middle rung. We hold the presidential tally at two grains and
-- nothing in between:
--
--   national   presidential_2023_results   (migration 0015, from the INEC report)
--   LGA        <- this table
--   per-PU     verified_results            (migration 0018, third-party extraction)
--
-- Without the middle, a per-PU baseline can only be checked against a single
-- national total, where a discrepancy could be anywhere among 176,846 units.
-- With it, summing polling units into their LGA localises a disagreement to
-- roughly 230 units, which is small enough to audit by hand.
--
-- Provenance: obtained from INEC under a Freedom of Information Act request,
-- answered eight months later. These are official figures -- unlike the per-PU
-- baseline, which is a third-party reading of scanned forms. The distinction
-- matters and is why this lives in its own reference table rather than in
-- verified_results.
--
-- Loaded by scripts/load_2023_lga_results.py. See
-- data/pu-enrichment-2023/SOURCES.md.

BEGIN;

CREATE TABLE presidential_2023_lga_results (
  election_id   TEXT NOT NULL REFERENCES elections(id),
  lga_code      TEXT NOT NULL REFERENCES lgas(code),
  party_code    TEXT NOT NULL,          -- not FK'd, matching the convention in
                                        -- presidential_2023_results (0015)
  votes         INTEGER NOT NULL CHECK (votes >= 0),
  source        TEXT NOT NULL,          -- e.g. 'inec_foia_2023'
  loaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (election_id, lga_code, party_code)
);

CREATE INDEX idx_lga_results_lga ON presidential_2023_lga_results (lga_code);

COMMENT ON TABLE presidential_2023_lga_results IS
  'Official per-LGA presidential vote tallies, obtained from INEC under FOIA.
   Covers the four major parties only -- the source carries no others, so a
   sum across this table is a FOUR-PARTY total and falls short of the national
   valid-vote figure by roughly the 14 minor parties'' ~570k votes. Do not
   present a sum here as a complete valid-vote total.';

COMMIT;
