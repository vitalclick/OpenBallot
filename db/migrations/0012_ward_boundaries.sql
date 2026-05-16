-- OpenBallot Nigeria - Migration 0012
-- Ward boundary polygons (~8,800 wards nationwide).
--
-- INEC does not publish ward shapes. The de facto open dataset is the
-- GRID3 Nigeria Operational Wards layer, mirrored on HDX as part of the
-- OCHA Common Operational Datasets (cod-ab-nga). Polygons are loaded
-- operator-side via scripts/load_ward_boundaries.py, which reconciles
-- GRID3 ward names to INEC ward codes (see scripts/reconcile_ward_names.py
-- and docs/WARD_BOUNDARIES.md).
--
-- This migration mirrors 0011 (state_boundaries / lga_boundaries):
--   * adds a polygon table keyed on the INEC ward code
--   * tracks provenance (source, loaded_at, plus a match_confidence
--     score for the GRID3<->INEC join so dashboards can surface
--     low-confidence reconciliations)
--   * updates mvt_wards to emit the real fill geometry when present,
--     falling back to the existing centroid so the map degrades
--     gracefully when polygons have not been loaded for a ward.

BEGIN;

CREATE TABLE ward_boundaries (
  ward_code         TEXT PRIMARY KEY REFERENCES wards(code),
  geog              GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
  source            TEXT NOT NULL DEFAULT 'unknown',
  source_ward_id    TEXT,                          -- e.g. GRID3 ward P-code
  match_confidence  NUMERIC(4, 3),                 -- 0.000..1.000
  loaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ward_boundaries_geog ON ward_boundaries USING GIST(geog);
CREATE INDEX idx_ward_boundaries_confidence
  ON ward_boundaries(match_confidence)
  WHERE match_confidence < 0.9;

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
        ST_Transform(
          COALESCE(b.geog::geometry, w.centroid),
          3857
        ),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_ward_centroids w
    LEFT JOIN ward_boundaries b ON b.ward_code = w.ward_code
    WHERE ST_Intersects(
      ST_Transform(COALESCE(b.geog::geometry, w.centroid), 3857),
      ST_TileEnvelope(z, x, y)
    )
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::BYTEA);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
