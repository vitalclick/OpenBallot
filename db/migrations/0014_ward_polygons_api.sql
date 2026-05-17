-- OpenBallot Nigeria - Migration 0014
-- Ward polygon fetch function for the public map.
--
-- The map's LGA-focus view replaces the proportional-symbol circles
-- with real ward polygons drawn from ward_boundaries (loaded once via
-- scripts/load_ward_boundaries.py against the GRID3 Nigeria Operational
-- Wards layer). One round-trip per LGA returns ~10-25 wards with their
-- polygons inlined as GeoJSON; the client falls back to centroid
-- symbols for wards whose GRID3 reconciliation hasn't been resolved
-- yet (those rows come through with geometry = NULL).
--
-- The function is keyed on lga_code only because polygons are
-- election-agnostic; the per-election fill colouring uses the existing
-- fn_ward_aggregates result.

BEGIN;

CREATE OR REPLACE FUNCTION fn_lga_ward_polygons(p_lga TEXT)
RETURNS TABLE (
  code              TEXT,
  name              TEXT,
  lga_code          TEXT,
  state_code        TEXT,
  match_confidence  NUMERIC(4, 3),
  boundary_source   TEXT,
  geometry          JSONB
) LANGUAGE sql STABLE AS $$
  SELECT
    w.code,
    w.name,
    w.lga_code,
    l.state_code,
    wb.match_confidence,
    wb.source,
    CASE
      WHEN wb.geog IS NULL THEN NULL
      ELSE ST_AsGeoJSON(wb.geog)::jsonb
    END AS geometry
  FROM wards w
  JOIN lgas l ON l.code = w.lga_code
  LEFT JOIN ward_boundaries wb ON wb.ward_code = w.code
  WHERE w.lga_code = p_lga
  ORDER BY w.name;
$$;

GRANT EXECUTE ON FUNCTION fn_lga_ward_polygons(TEXT) TO anon, authenticated, service_role;

COMMIT;
