-- OpenBallot Nigeria - Migration 0013
-- Region-level aggregate functions for the public map.
--
-- The /api/v1/elections/{id}/aggregates endpoint hits one of these
-- functions per level. They join the per-region centroid views
-- (mv_state_centroids / mv_lga_centroids / mv_ward_centroids) against
-- per-PU verification status filtered to the requested election, and
-- return one row per region with the full status breakdown plus a
-- leader party derived from consensus_data.
--
-- The map renders the result as a proportional symbol (radius scales
-- with pu_count, fill colour scales with % consensus). This replaces
-- the previous "dump 13,325 polling unit dots on Lagos State" pattern
-- - the per-PU dot layer is only shown once the user drills into a
-- single ward (max ~282 dots, always readable).

BEGIN;

-- Helper: per-region status breakdown for a given election. Reused by
-- the three level-specific functions below via a CTE.

CREATE OR REPLACE FUNCTION fn_state_aggregates(p_election TEXT)
RETURNS TABLE (
  level                 TEXT,
  code                  TEXT,
  name                  TEXT,
  parent_code           TEXT,
  state_code            TEXT,
  pu_count              BIGINT,
  units_reporting       BIGINT,
  units_consensus       BIGINT,
  units_discrepancy     BIGINT,
  units_inec_confirmed  BIGINT,
  units_inec_conflict   BIGINT,
  units_inec_published  BIGINT,
  units_single_source   BIGINT,
  centroid_lng          DOUBLE PRECISION,
  centroid_lat          DOUBLE PRECISION,
  leader_party          TEXT,
  leader_share          NUMERIC
) AS $$
  WITH bucket AS (
    SELECT
      pu.state_code,
      COUNT(*)                                                    AS pu_count,
      COUNT(*) FILTER (WHERE vr.status IS NOT NULL
                       AND vr.status <> 'no_data')                AS units_reporting,
      COUNT(*) FILTER (WHERE vr.status = 'consensus')             AS units_consensus,
      COUNT(*) FILTER (WHERE vr.status = 'discrepancy')           AS units_discrepancy,
      COUNT(*) FILTER (WHERE vr.status = 'inec_confirmed')        AS units_inec_confirmed,
      COUNT(*) FILTER (WHERE vr.status = 'inec_conflict')         AS units_inec_conflict,
      COUNT(*) FILTER (WHERE vr.status = 'inec_published')        AS units_inec_published,
      COUNT(*) FILTER (WHERE vr.status = 'single_source')         AS units_single_source
    FROM polling_units pu
    LEFT JOIN verified_results vr
      ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
    GROUP BY pu.state_code
  ),
  party AS (
    SELECT
      pu.state_code,
      kv.key                  AS party_code,
      SUM((kv.value)::NUMERIC) AS votes
    FROM polling_units pu
    JOIN verified_results vr
      ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
    CROSS JOIN LATERAL jsonb_each_text(
      COALESCE(vr.consensus_data -> 'candidate_votes', '{}'::jsonb)
    ) kv
    WHERE vr.status IN ('consensus', 'inec_confirmed', 'inec_published')
    GROUP BY pu.state_code, kv.key
  ),
  leader AS (
    SELECT DISTINCT ON (p.state_code)
      p.state_code,
      p.party_code,
      p.votes,
      SUM(p.votes) OVER (PARTITION BY p.state_code) AS total_votes
    FROM party p
    ORDER BY p.state_code, p.votes DESC
  )
  SELECT
    'state'::TEXT,
    s.code,
    s.name,
    NULL::TEXT                              AS parent_code,
    s.code                                  AS state_code,
    COALESCE(b.pu_count, 0),
    COALESCE(b.units_reporting, 0),
    COALESCE(b.units_consensus, 0),
    COALESCE(b.units_discrepancy, 0),
    COALESCE(b.units_inec_confirmed, 0),
    COALESCE(b.units_inec_conflict, 0),
    COALESCE(b.units_inec_published, 0),
    COALESCE(b.units_single_source, 0),
    ST_X(mvc.centroid::geometry)            AS centroid_lng,
    ST_Y(mvc.centroid::geometry)            AS centroid_lat,
    ld.party_code,
    CASE WHEN ld.total_votes > 0
         THEN ROUND(ld.votes / ld.total_votes, 4)
         ELSE NULL
    END                                     AS leader_share
  FROM states s
  LEFT JOIN mv_state_centroids mvc ON mvc.state_code = s.code
  LEFT JOIN bucket b               ON b.state_code   = s.code
  LEFT JOIN leader ld              ON ld.state_code  = s.code;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fn_lga_aggregates(p_election TEXT, p_state TEXT)
RETURNS TABLE (
  level                 TEXT,
  code                  TEXT,
  name                  TEXT,
  parent_code           TEXT,
  state_code            TEXT,
  pu_count              BIGINT,
  units_reporting       BIGINT,
  units_consensus       BIGINT,
  units_discrepancy     BIGINT,
  units_inec_confirmed  BIGINT,
  units_inec_conflict   BIGINT,
  units_inec_published  BIGINT,
  units_single_source   BIGINT,
  centroid_lng          DOUBLE PRECISION,
  centroid_lat          DOUBLE PRECISION,
  leader_party          TEXT,
  leader_share          NUMERIC
) AS $$
  WITH bucket AS (
    SELECT
      pu.lga_code,
      COUNT(*)                                                    AS pu_count,
      COUNT(*) FILTER (WHERE vr.status IS NOT NULL
                       AND vr.status <> 'no_data')                AS units_reporting,
      COUNT(*) FILTER (WHERE vr.status = 'consensus')             AS units_consensus,
      COUNT(*) FILTER (WHERE vr.status = 'discrepancy')           AS units_discrepancy,
      COUNT(*) FILTER (WHERE vr.status = 'inec_confirmed')        AS units_inec_confirmed,
      COUNT(*) FILTER (WHERE vr.status = 'inec_conflict')         AS units_inec_conflict,
      COUNT(*) FILTER (WHERE vr.status = 'inec_published')        AS units_inec_published,
      COUNT(*) FILTER (WHERE vr.status = 'single_source')         AS units_single_source
    FROM polling_units pu
    LEFT JOIN verified_results vr
      ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
    WHERE pu.state_code = p_state
    GROUP BY pu.lga_code
  ),
  party AS (
    SELECT
      pu.lga_code,
      kv.key                  AS party_code,
      SUM((kv.value)::NUMERIC) AS votes
    FROM polling_units pu
    JOIN verified_results vr
      ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
    CROSS JOIN LATERAL jsonb_each_text(
      COALESCE(vr.consensus_data -> 'candidate_votes', '{}'::jsonb)
    ) kv
    WHERE pu.state_code = p_state
      AND vr.status IN ('consensus', 'inec_confirmed', 'inec_published')
    GROUP BY pu.lga_code, kv.key
  ),
  leader AS (
    SELECT DISTINCT ON (p.lga_code)
      p.lga_code,
      p.party_code,
      p.votes,
      SUM(p.votes) OVER (PARTITION BY p.lga_code) AS total_votes
    FROM party p
    ORDER BY p.lga_code, p.votes DESC
  )
  SELECT
    'lga'::TEXT,
    l.code,
    l.name,
    l.state_code                            AS parent_code,
    l.state_code,
    COALESCE(b.pu_count, 0),
    COALESCE(b.units_reporting, 0),
    COALESCE(b.units_consensus, 0),
    COALESCE(b.units_discrepancy, 0),
    COALESCE(b.units_inec_confirmed, 0),
    COALESCE(b.units_inec_conflict, 0),
    COALESCE(b.units_inec_published, 0),
    COALESCE(b.units_single_source, 0),
    ST_X(mvc.centroid::geometry)            AS centroid_lng,
    ST_Y(mvc.centroid::geometry)            AS centroid_lat,
    ld.party_code,
    CASE WHEN ld.total_votes > 0
         THEN ROUND(ld.votes / ld.total_votes, 4)
         ELSE NULL
    END                                     AS leader_share
  FROM lgas l
  LEFT JOIN mv_lga_centroids mvc ON mvc.lga_code = l.code
  LEFT JOIN bucket b             ON b.lga_code   = l.code
  LEFT JOIN leader ld            ON ld.lga_code  = l.code
  WHERE l.state_code = p_state;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fn_ward_aggregates(p_election TEXT, p_lga TEXT)
RETURNS TABLE (
  level                 TEXT,
  code                  TEXT,
  name                  TEXT,
  parent_code           TEXT,
  state_code            TEXT,
  pu_count              BIGINT,
  units_reporting       BIGINT,
  units_consensus       BIGINT,
  units_discrepancy     BIGINT,
  units_inec_confirmed  BIGINT,
  units_inec_conflict   BIGINT,
  units_inec_published  BIGINT,
  units_single_source   BIGINT,
  centroid_lng          DOUBLE PRECISION,
  centroid_lat          DOUBLE PRECISION,
  leader_party          TEXT,
  leader_share          NUMERIC
) AS $$
  WITH bucket AS (
    SELECT
      pu.ward_code,
      COUNT(*)                                                    AS pu_count,
      COUNT(*) FILTER (WHERE vr.status IS NOT NULL
                       AND vr.status <> 'no_data')                AS units_reporting,
      COUNT(*) FILTER (WHERE vr.status = 'consensus')             AS units_consensus,
      COUNT(*) FILTER (WHERE vr.status = 'discrepancy')           AS units_discrepancy,
      COUNT(*) FILTER (WHERE vr.status = 'inec_confirmed')        AS units_inec_confirmed,
      COUNT(*) FILTER (WHERE vr.status = 'inec_conflict')         AS units_inec_conflict,
      COUNT(*) FILTER (WHERE vr.status = 'inec_published')        AS units_inec_published,
      COUNT(*) FILTER (WHERE vr.status = 'single_source')         AS units_single_source
    FROM polling_units pu
    LEFT JOIN verified_results vr
      ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
    WHERE pu.lga_code = p_lga
    GROUP BY pu.ward_code
  ),
  party AS (
    SELECT
      pu.ward_code,
      kv.key                  AS party_code,
      SUM((kv.value)::NUMERIC) AS votes
    FROM polling_units pu
    JOIN verified_results vr
      ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
    CROSS JOIN LATERAL jsonb_each_text(
      COALESCE(vr.consensus_data -> 'candidate_votes', '{}'::jsonb)
    ) kv
    WHERE pu.lga_code = p_lga
      AND vr.status IN ('consensus', 'inec_confirmed', 'inec_published')
    GROUP BY pu.ward_code, kv.key
  ),
  leader AS (
    SELECT DISTINCT ON (p.ward_code)
      p.ward_code,
      p.party_code,
      p.votes,
      SUM(p.votes) OVER (PARTITION BY p.ward_code) AS total_votes
    FROM party p
    ORDER BY p.ward_code, p.votes DESC
  )
  SELECT
    'ward'::TEXT,
    w.code,
    w.name,
    w.lga_code                              AS parent_code,
    l.state_code,
    COALESCE(b.pu_count, 0),
    COALESCE(b.units_reporting, 0),
    COALESCE(b.units_consensus, 0),
    COALESCE(b.units_discrepancy, 0),
    COALESCE(b.units_inec_confirmed, 0),
    COALESCE(b.units_inec_conflict, 0),
    COALESCE(b.units_inec_published, 0),
    COALESCE(b.units_single_source, 0),
    ST_X(mvc.centroid::geometry)            AS centroid_lng,
    ST_Y(mvc.centroid::geometry)            AS centroid_lat,
    ld.party_code,
    CASE WHEN ld.total_votes > 0
         THEN ROUND(ld.votes / ld.total_votes, 4)
         ELSE NULL
    END                                     AS leader_share
  FROM wards w
  JOIN lgas l                     ON l.code = w.lga_code
  LEFT JOIN mv_ward_centroids mvc ON mvc.ward_code = w.code
  LEFT JOIN bucket b              ON b.ward_code   = w.code
  LEFT JOIN leader ld             ON ld.ward_code  = w.code
  WHERE w.lga_code = p_lga;
$$ LANGUAGE sql STABLE;

-- Updated tile functions: emit the human-readable `lga_name` /
-- `ward_name` plus per-region status counts so the Mapbox renderer can
-- (a) put a real name in the breadcrumb on click and (b) drive the
-- choropleth fill for LGAs / wards without an extra client join.

CREATE OR REPLACE FUNCTION mvt_lgas(z INTEGER, x INTEGER, y INTEGER, p_election TEXT)
RETURNS BYTEA AS $$
DECLARE
  result BYTEA;
BEGIN
  SELECT INTO result ST_AsMVT(t, 'lgas', 4096, 'geom')
  FROM (
    SELECT
      l.lga_code,
      lg.name        AS lga_name,
      l.state_code,
      l.pu_count,
      COALESCE(bucket.units_reporting, 0)     AS units_reporting,
      COALESCE(bucket.units_consensus, 0)     AS units_consensus,
      COALESCE(bucket.units_discrepancy, 0)   AS units_discrepancy,
      COALESCE(bucket.units_inec_conflict, 0) AS units_inec_conflict,
      ST_AsMVTGeom(
        ST_Transform(
          COALESCE(b.geog::geometry, l.centroid),
          3857
        ),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_lga_centroids l
    JOIN lgas lg                       ON lg.code = l.lga_code
    LEFT JOIN lga_boundaries b          ON b.lga_code = l.lga_code
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE vr.status IS NOT NULL AND vr.status <> 'no_data') AS units_reporting,
        COUNT(*) FILTER (WHERE vr.status = 'consensus')      AS units_consensus,
        COUNT(*) FILTER (WHERE vr.status = 'discrepancy')    AS units_discrepancy,
        COUNT(*) FILTER (WHERE vr.status = 'inec_conflict')  AS units_inec_conflict
      FROM polling_units pu
      LEFT JOIN verified_results vr
        ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
      WHERE pu.lga_code = l.lga_code
    ) bucket ON TRUE
    WHERE ST_Intersects(
      ST_Transform(COALESCE(b.geog::geometry, l.centroid), 3857),
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
      wd.name        AS ward_name,
      w.lga_code,
      w.state_code,
      w.pu_count,
      COALESCE(bucket.units_reporting, 0)     AS units_reporting,
      COALESCE(bucket.units_consensus, 0)     AS units_consensus,
      COALESCE(bucket.units_discrepancy, 0)   AS units_discrepancy,
      COALESCE(bucket.units_inec_conflict, 0) AS units_inec_conflict,
      ST_AsMVTGeom(
        ST_Transform(
          COALESCE(b.geog::geometry, w.centroid),
          3857
        ),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom
    FROM mv_ward_centroids w
    JOIN wards wd                       ON wd.code = w.ward_code
    LEFT JOIN ward_boundaries b         ON b.ward_code = w.ward_code
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE vr.status IS NOT NULL AND vr.status <> 'no_data') AS units_reporting,
        COUNT(*) FILTER (WHERE vr.status = 'consensus')      AS units_consensus,
        COUNT(*) FILTER (WHERE vr.status = 'discrepancy')    AS units_discrepancy,
        COUNT(*) FILTER (WHERE vr.status = 'inec_conflict')  AS units_inec_conflict
      FROM polling_units pu
      LEFT JOIN verified_results vr
        ON vr.pu_code = pu.pu_code AND vr.election_id = p_election
      WHERE pu.ward_code = w.ward_code
    ) bucket ON TRUE
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
