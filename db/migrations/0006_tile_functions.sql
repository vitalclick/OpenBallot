-- OpenBallot Nigeria - Migration 0006
-- Vector tile (MVT) generation functions.
--
-- Approach
--   * One SQL function per zoom band so each tile is fed exactly the
--     features it should render. We do not return 176k features per tile
--     at zoom 4 - that would be both slow and useless.
--   * Z 0-5  : per-state aggregate at the state centroid (37 features
--              nationwide, one per state + FCT)
--   * Z 6-8  : per-LGA aggregate at the LGA centroid (~774 features)
--   * Z 9-10 : per-ward aggregate at the ward centroid (~8.8k features)
--   * Z 11+  : individual polling units, clipped to the tile envelope
--
-- All functions take (z, x, y, election_id) and return `bytea`. The web
-- tile route just SELECTs and pipes the bytes back with the right
-- Content-Type.

BEGIN;

-- Helper: which party leads a candidate_votes JSONB blob, and by what share.
-- Returns NULL party when the data is empty.
CREATE OR REPLACE FUNCTION fn_leader(votes JSONB)
RETURNS TABLE(party TEXT, share NUMERIC) AS $$
DECLARE
  total NUMERIC := 0;
  best_party TEXT := NULL;
  best NUMERIC := 0;
  kv RECORD;
BEGIN
  IF votes IS NULL OR votes = '{}'::jsonb THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::NUMERIC;
    RETURN;
  END IF;

  FOR kv IN SELECT key, (value)::numeric AS v FROM jsonb_each_text(votes) LOOP
    total := total + kv.v;
    IF kv.v > best THEN
      best := kv.v;
      best_party := kv.key;
    END IF;
  END LOOP;

  IF total = 0 THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::NUMERIC;
  ELSE
    RETURN QUERY SELECT best_party, ROUND(best / total, 4);
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Centroid per state. Precomputed view so we are not averaging 5k points
-- on every tile request.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_state_centroids AS
SELECT
  state_code,
  ST_Centroid(ST_Collect(geog::geometry)) AS centroid,
  COUNT(*) AS pu_count
FROM polling_units
WHERE geog IS NOT NULL
GROUP BY state_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_state_centroids ON mv_state_centroids(state_code);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_lga_centroids AS
SELECT
  lga_code,
  state_code,
  ST_Centroid(ST_Collect(geog::geometry)) AS centroid,
  COUNT(*) AS pu_count
FROM polling_units
WHERE geog IS NOT NULL
GROUP BY lga_code, state_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_lga_centroids ON mv_lga_centroids(lga_code);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_ward_centroids AS
SELECT
  ward_code,
  lga_code,
  state_code,
  ST_Centroid(ST_Collect(geog::geometry)) AS centroid,
  COUNT(*) AS pu_count
FROM polling_units
WHERE geog IS NOT NULL
GROUP BY ward_code, lga_code, state_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_ward_centroids ON mv_ward_centroids(ward_code);

-- ─── Tile functions ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mvt_states(z INTEGER, x INTEGER, y INTEGER, p_election TEXT)
RETURNS BYTEA AS $$
DECLARE
  result BYTEA;
BEGIN
  SELECT INTO result ST_AsMVT(t, 'states', 4096, 'geom')
  FROM (
    SELECT
      s.state_code,
      s.pu_count,
      COALESCE(rollup.units_reporting, 0) AS units_reporting,
      COALESCE(rollup.units_consensus, 0) AS units_consensus,
      COALESCE(rollup.units_discrepancy, 0) AS units_discrepancy,
      COALESCE(rollup.units_inec_conflict, 0) AS units_inec_conflict,
      COALESCE((rollup.party_totals)::TEXT, '{}') AS party_totals_json,
      ST_AsMVTGeom(
        ST_Transform(s.centroid, 3857),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_state_centroids s
    LEFT JOIN mv_state_rollup rollup
      ON rollup.state_code = s.state_code AND rollup.election_id = p_election
    WHERE ST_Intersects(
      ST_Transform(s.centroid, 3857),
      ST_TileEnvelope(z, x, y)
    )
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::BYTEA);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION mvt_lgas(z INTEGER, x INTEGER, y INTEGER, p_election TEXT)
RETURNS BYTEA AS $$
DECLARE
  result BYTEA;
BEGIN
  SELECT INTO result ST_AsMVT(t, 'lgas', 4096, 'geom')
  FROM (
    SELECT
      l.lga_code,
      l.state_code,
      l.pu_count,
      ST_AsMVTGeom(
        ST_Transform(l.centroid, 3857),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_lga_centroids l
    WHERE ST_Intersects(
      ST_Transform(l.centroid, 3857),
      ST_TileEnvelope(z, x, y)
    )
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::BYTEA);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION mvt_wards(z INTEGER, x INTEGER, y INTEGER, p_election TEXT)
RETURNS BYTEA AS $$
DECLARE
  result BYTEA;
BEGIN
  SELECT INTO result ST_AsMVT(t, 'wards', 4096, 'geom')
  FROM (
    SELECT
      w.ward_code,
      w.lga_code,
      w.state_code,
      w.pu_count,
      ST_AsMVTGeom(
        ST_Transform(w.centroid, 3857),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_ward_centroids w
    WHERE ST_Intersects(
      ST_Transform(w.centroid, 3857),
      ST_TileEnvelope(z, x, y)
    )
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::BYTEA);
END;
$$ LANGUAGE plpgsql STABLE;

-- Polling units: one feature per PU, with the verified_results status
-- baked in so the renderer needs zero joins client-side.
--
-- `status_int` is a compact encoding so MVT property storage stays small:
--   0 no_data, 1 single_source, 2 inec_published, 3 consensus,
--   4 discrepancy, 5 inec_confirmed, 6 inec_conflict
CREATE OR REPLACE FUNCTION mvt_polling_units(z INTEGER, x INTEGER, y INTEGER, p_election TEXT)
RETURNS BYTEA AS $$
DECLARE
  result BYTEA;
BEGIN
  SELECT INTO result ST_AsMVT(t, 'polling_units', 4096, 'geom')
  FROM (
    SELECT
      pu.pu_code,
      pu.ward_code,
      pu.lga_code,
      pu.state_code,
      CASE COALESCE(vr.status::TEXT, 'no_data')
        WHEN 'no_data'        THEN 0
        WHEN 'single_source'  THEN 1
        WHEN 'inec_published' THEN 2
        WHEN 'consensus'      THEN 3
        WHEN 'discrepancy'    THEN 4
        WHEN 'inec_confirmed' THEN 5
        WHEN 'inec_conflict'  THEN 6
      END AS status_int,
      ldr.party AS leader,
      ldr.share AS leader_share,
      ST_AsMVTGeom(
        ST_Transform(pu.geog::geometry, 3857),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM polling_units pu
    LEFT JOIN verified_results vr
      ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
    LEFT JOIN LATERAL fn_leader(vr.consensus_data -> 'candidate_votes') ldr ON TRUE
    WHERE pu.geog IS NOT NULL
      AND ST_Intersects(
        ST_Transform(pu.geog::geometry, 3857),
        ST_TileEnvelope(z, x, y)
      )
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::BYTEA);
END;
$$ LANGUAGE plpgsql STABLE;

-- Single entry point that picks the right layer for the zoom level.
-- The web tile route calls this and forwards the bytes.
CREATE OR REPLACE FUNCTION mvt_tile(z INTEGER, x INTEGER, y INTEGER, p_election TEXT)
RETURNS BYTEA AS $$
BEGIN
  IF z <= 5 THEN
    RETURN mvt_states(z, x, y, p_election);
  ELSIF z <= 8 THEN
    RETURN mvt_lgas(z, x, y, p_election);
  ELSIF z <= 10 THEN
    RETURN mvt_wards(z, x, y, p_election);
  ELSE
    RETURN mvt_polling_units(z, x, y, p_election);
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Refresh helper called by the worker after a batch of submissions lands.
CREATE OR REPLACE FUNCTION refresh_tile_caches() RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_state_centroids;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lga_centroids;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ward_centroids;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_state_rollup;
EXCEPTION
  -- CONCURRENTLY requires a unique index; if missing the first time, do a
  -- non-concurrent refresh instead.
  WHEN feature_not_supported THEN
    REFRESH MATERIALIZED VIEW mv_state_centroids;
    REFRESH MATERIALIZED VIEW mv_lga_centroids;
    REFRESH MATERIALIZED VIEW mv_ward_centroids;
    REFRESH MATERIALIZED VIEW mv_state_rollup;
END;
$$ LANGUAGE plpgsql;

COMMIT;
