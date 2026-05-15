-- OpenBallot Nigeria - Migration 0008
-- Statistical anomaly detection.
--
-- The third pillar of trust on the platform (after multi-source
-- consensus and the audit chain). Catches the cases where ALL the
-- submissions for a PU agree but the agreed-on numbers are themselves
-- implausible - e.g. votes exceed registered voters, or the leader has
-- 99.5% in a unit whose neighbours split evenly, or 2027 turnout is
-- 4x what the same PU produced in 2023.
--
-- Anomalies are NOT the same as discrepancies:
--   * A discrepancy means two sources disagree.
--   * An anomaly means the data is internally or contextually wrong.
-- A PU can be flagged as both. Both surface publicly.

BEGIN;

CREATE TYPE anomaly_type AS ENUM (
  -- Sanity (impossibility) checks
  'votes_exceed_registered',
  'turnout_exceeds_accreditation',
  'rejected_exceeds_cast',
  'leader_extreme_share',
  'zero_registered_voters',
  'cast_zero_but_votes_recorded',
  -- Statistical outliers (peer distribution)
  'turnout_outlier_ward',
  'turnout_outlier_lga',
  'leader_share_outlier_ward',
  -- Historical comparison
  'turnout_shift_vs_2023',
  'leader_party_shift_vs_2023'
);

CREATE TABLE anomalies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  election_id     TEXT NOT NULL REFERENCES elections(id),
  pu_code         TEXT NOT NULL REFERENCES polling_units(pu_code),
  submission_id   UUID REFERENCES ec8a_submissions(id),
  anomaly_type    anomaly_type NOT NULL,
  severity        INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  details         JSONB NOT NULL,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  UNIQUE (election_id, pu_code, anomaly_type, submission_id)
);
CREATE INDEX idx_anom_election_pu ON anomalies (election_id, pu_code);
CREATE INDEX idx_anom_open        ON anomalies (election_id, anomaly_type)
  WHERE resolved_at IS NULL;
CREATE INDEX idx_anom_severity    ON anomalies (election_id, severity DESC, detected_at DESC);

-- Public view that joins to polling unit detail.
CREATE OR REPLACE VIEW v_anomaly_register AS
SELECT
  a.id,
  a.election_id,
  a.pu_code,
  pu.pu_name,
  pu.ward_code,
  pu.lga_code,
  pu.state_code,
  a.anomaly_type,
  a.severity,
  a.details,
  a.detected_at,
  a.resolved_at,
  a.submission_id
FROM anomalies a
JOIN polling_units pu ON pu.pu_code = a.pu_code;

-- ────────────────────────────────────────────────────────────────────────────
-- Materialised per-ward turnout distribution. The statistical detector
-- pulls from this so it does not recompute the population mean/stddev for
-- every PU it checks. Refreshed by the worker on a fixed cadence.
-- ────────────────────────────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW mv_ward_turnout_dist AS
SELECT
  vr.election_id,
  pu.ward_code,
  COUNT(*) AS n_units,
  AVG(
    CASE WHEN (vr.consensus_data->>'registered_voters')::numeric > 0
         THEN (vr.consensus_data->>'total_votes_cast')::numeric
              / (vr.consensus_data->>'registered_voters')::numeric
    END
  ) AS mean_turnout,
  STDDEV(
    CASE WHEN (vr.consensus_data->>'registered_voters')::numeric > 0
         THEN (vr.consensus_data->>'total_votes_cast')::numeric
              / (vr.consensus_data->>'registered_voters')::numeric
    END
  ) AS stddev_turnout
FROM verified_results vr
JOIN polling_units pu ON pu.pu_code = vr.pu_code
WHERE vr.consensus_data IS NOT NULL
GROUP BY vr.election_id, pu.ward_code
HAVING COUNT(*) >= 5;

CREATE UNIQUE INDEX uq_mv_ward_turnout_dist
  ON mv_ward_turnout_dist (election_id, ward_code);

CREATE MATERIALIZED VIEW mv_lga_turnout_dist AS
SELECT
  vr.election_id,
  pu.lga_code,
  COUNT(*) AS n_units,
  AVG(
    CASE WHEN (vr.consensus_data->>'registered_voters')::numeric > 0
         THEN (vr.consensus_data->>'total_votes_cast')::numeric
              / (vr.consensus_data->>'registered_voters')::numeric
    END
  ) AS mean_turnout,
  STDDEV(
    CASE WHEN (vr.consensus_data->>'registered_voters')::numeric > 0
         THEN (vr.consensus_data->>'total_votes_cast')::numeric
              / (vr.consensus_data->>'registered_voters')::numeric
    END
  ) AS stddev_turnout
FROM verified_results vr
JOIN polling_units pu ON pu.pu_code = vr.pu_code
WHERE vr.consensus_data IS NOT NULL
GROUP BY vr.election_id, pu.lga_code
HAVING COUNT(*) >= 10;

CREATE UNIQUE INDEX uq_mv_lga_turnout_dist
  ON mv_lga_turnout_dist (election_id, lga_code);

-- Helper to refresh both. Called by the worker batch job.
CREATE OR REPLACE FUNCTION refresh_anomaly_baselines() RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ward_turnout_dist;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lga_turnout_dist;
EXCEPTION
  WHEN feature_not_supported THEN
    REFRESH MATERIALIZED VIEW mv_ward_turnout_dist;
    REFRESH MATERIALIZED VIEW mv_lga_turnout_dist;
END;
$$ LANGUAGE plpgsql;

COMMIT;
