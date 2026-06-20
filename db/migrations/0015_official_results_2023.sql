-- OpenBallot Nigeria - Migration 0015
-- Official 2023 General Election results extracted from the INEC report PDF.
--
-- This is a REFERENCE / baseline layer, distinct from the per-polling-unit
-- evidentiary core (ec8a_submissions / verified_results). The INEC report
-- carries results only at national level (presidential) and at the
-- constituency level as declared *winners* (no vote tallies) for the
-- legislative and governorship races -- it has nothing per polling unit.
-- The per-PU surface is still populated separately by the IReV pipeline.
--
-- Tables here are DDL-only; data is loaded by scripts/load_2023_results.py
-- from data/election-results-2023/, which the extractor (extract_2023_results.py)
-- generates from documents/2023-GENERAL-ELECTION-REPORT.pdf. See
-- data/election-results-2023/SOURCES.md for provenance.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Presidential national result (Annexure 2). One row per registered party.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE presidential_2023_results (
  election_id     TEXT NOT NULL REFERENCES elections(id),
  party_code      TEXT NOT NULL,            -- not FK'd: includes all 18 parties,
                                            -- which the dev seed does not carry
  candidate_name  TEXT NOT NULL,
  votes           BIGINT NOT NULL CHECK (votes >= 0),
  elected         BOOLEAN NOT NULL DEFAULT FALSE,
  display_order   INTEGER NOT NULL,         -- rank by votes, 1 = winner
  PRIMARY KEY (election_id, party_code)
);

-- National turnout summary (the infographic's footer box). One row per election.
CREATE TABLE presidential_2023_summary (
  election_id        TEXT PRIMARY KEY REFERENCES elections(id),
  registered_voters  BIGINT NOT NULL,
  collected_pvcs     BIGINT NOT NULL,
  accredited_voters  BIGINT NOT NULL,
  votes_cast         BIGINT NOT NULL,
  valid_votes        BIGINT NOT NULL,
  rejected_votes     BIGINT NOT NULL,
  turnout_pct        NUMERIC(5, 2) NOT NULL
);

-- ────────────────────────────────────────────────────────────────────────────
-- Declared winners for the four non-presidential races (Annexures 3-6).
-- Party only (plus elected-candidate name for the state-assembly race); no
-- vote tallies exist in the source.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE declared_winners_2023 (
  election_id        TEXT NOT NULL REFERENCES elections(id),
  race               TEXT NOT NULL
                       CHECK (race IN ('governorship', 'senate', 'reps', 'stha')),
  seq                INTEGER NOT NULL,       -- per-race printed order; stable key
                                             -- (printed codes carry source typos)
  constituency_code  TEXT NOT NULL,          -- INEC code, as printed (may repeat)
  constituency_name  TEXT,
  state_code         TEXT NOT NULL REFERENCES states(code),
  n_lgas             INTEGER,
  n_ras              INTEGER,
  n_pus              INTEGER,
  party_code         TEXT,                   -- NULL where the source omitted it
  candidate_name     TEXT,
  PRIMARY KEY (election_id, seq)
);
CREATE INDEX idx_dw23_state ON declared_winners_2023 (state_code);
CREATE INDEX idx_dw23_party ON declared_winners_2023 (election_id, party_code);

-- ────────────────────────────────────────────────────────────────────────────
-- Registered voters per state by gender (Table 8.9).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE state_registration_2023 (
  state_code   TEXT PRIMARY KEY REFERENCES states(code),
  male         BIGINT NOT NULL CHECK (male >= 0),
  female       BIGINT NOT NULL CHECK (female >= 0),
  total        BIGINT NOT NULL CHECK (total >= 0)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Public read-only access. Mirrors the anon read surface in db/policies/rls.sql:
-- these are concluded, published, official results — fully public.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE presidential_2023_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE presidential_2023_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE declared_winners_2023     ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_registration_2023   ENABLE ROW LEVEL SECURITY;

CREATE POLICY pub_read_pres_results ON presidential_2023_results FOR SELECT USING (TRUE);
CREATE POLICY pub_read_pres_summary ON presidential_2023_summary FOR SELECT USING (TRUE);
CREATE POLICY pub_read_declared     ON declared_winners_2023     FOR SELECT USING (TRUE);
CREATE POLICY pub_read_state_reg    ON state_registration_2023   FOR SELECT USING (TRUE);

COMMIT;
