-- OpenBallot Nigeria - Migration 0011
-- State + LGA boundary polygons for choropleth rendering.
--
-- The previous mvt_states / mvt_lgas tile functions emitted centroid
-- points. That renders as a dot at low zoom, which works for a demo
-- but does not give the choropleth fill the README promises. This
-- migration adds a polygon table plus updated tile functions that emit
-- real fill geometry when polygons are present (falling back to the
-- centroid if a state does not yet have a polygon loaded).
--
-- Polygons are loaded operator-side via scripts/load_state_polygons.py
-- from any standard Nigerian admin-boundary GeoJSON (OCHA/HDX or
-- equivalent). The seed file ships approximate polygons for the four
-- demo states so the page renders meaningfully on a fresh clone; the
-- full national dataset is operator-loaded.

BEGIN;

CREATE TABLE state_boundaries (
  state_code   TEXT PRIMARY KEY REFERENCES states(code),
  geog         GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
  source       TEXT NOT NULL DEFAULT 'unknown',
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_state_boundaries_geog ON state_boundaries USING GIST(geog);

CREATE TABLE lga_boundaries (
  lga_code     TEXT PRIMARY KEY REFERENCES lgas(code),
  geog         GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
  source       TEXT NOT NULL DEFAULT 'unknown',
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lga_boundaries_geog ON lga_boundaries USING GIST(geog);

-- Updated mvt_states: emit the polygon fill when present, otherwise
-- fall back to the centroid point so the map degrades gracefully if
-- polygons have not been loaded for a state.
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
      COALESCE(rollup.units_reporting, 0)      AS units_reporting,
      COALESCE(rollup.units_consensus, 0)      AS units_consensus,
      COALESCE(rollup.units_discrepancy, 0)    AS units_discrepancy,
      COALESCE(rollup.units_inec_conflict, 0)  AS units_inec_conflict,
      COALESCE((rollup.party_totals)::TEXT, '{}') AS party_totals_json,
      ST_AsMVTGeom(
        ST_Transform(
          COALESCE(b.geog::geometry, s.centroid),   -- polygon when loaded, centroid otherwise
          3857
        ),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_state_centroids s
    LEFT JOIN state_boundaries b ON b.state_code = s.state_code
    LEFT JOIN mv_state_rollup rollup
      ON rollup.state_code = s.state_code AND rollup.election_id = p_election
    WHERE ST_Intersects(
      ST_Transform(COALESCE(b.geog::geometry, s.centroid), 3857),
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
        ST_Transform(
          COALESCE(b.geog::geometry, l.centroid),
          3857
        ),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_lga_centroids l
    LEFT JOIN lga_boundaries b ON b.lga_code = l.lga_code
    WHERE ST_Intersects(
      ST_Transform(COALESCE(b.geog::geometry, l.centroid), 3857),
      ST_TileEnvelope(z, x, y)
    )
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::BYTEA);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
