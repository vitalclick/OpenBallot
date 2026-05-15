#!/usr/bin/env python3
"""Load Nigerian state polygons from a GeoJSON file into state_boundaries.

Input: a GeoJSON FeatureCollection where each Feature has a `state_code`
(or `STATE_CODE` / `iso_code` / `code`) property and a Polygon /
MultiPolygon geometry. OCHA's HDX dataset for Nigeria admin boundaries
ships exactly this shape after a trivial rename.

Usage:
    DATABASE_URL=postgresql://... \\
        python scripts/load_state_polygons.py nga_admbnda_adm1.geojson

The script:
  * Reads the GeoJSON
  * Normalises the state code via the configurable property-name list
  * Converts every Polygon to MultiPolygon (state_boundaries.geog is
    typed MULTIPOLYGON to keep the schema uniform)
  * Upserts each row by state_code

After load, run:
    SELECT refresh_anomaly_baselines();    -- not strictly needed
The mvt_states tile function picks up polygons immediately because it
joins to state_boundaries on every render.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import psycopg2

CODE_PROPERTIES = ("state_code", "STATE_CODE", "iso_code", "code", "ADM1_PCODE")


def _normalise_state_code(props: dict, fallback_name_to_code: dict[str, str]) -> str | None:
    for key in CODE_PROPERTIES:
        if key in props and props[key]:
            return str(props[key]).strip().upper()
    # Try matching on state name
    for key in ("state_name", "STATE_NAME", "name", "ADM1_EN"):
        if key in props and props[key]:
            normalised = str(props[key]).strip().lower()
            if normalised in fallback_name_to_code:
                return fallback_name_to_code[normalised]
    return None


def _to_multipolygon(geometry: dict) -> dict:
    if geometry["type"] == "MultiPolygon":
        return geometry
    if geometry["type"] == "Polygon":
        return {"type": "MultiPolygon", "coordinates": [geometry["coordinates"]]}
    raise ValueError(f"unsupported geometry type: {geometry['type']}")


def main(path: str) -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2

    payload = json.loads(Path(path).read_text())
    if payload.get("type") != "FeatureCollection":
        print("expected a GeoJSON FeatureCollection", file=sys.stderr)
        return 2

    conn = psycopg2.connect(url)
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute("SELECT code, lower(name) FROM states")
    name_to_code = {n: c for c, n in cur.fetchall()}

    loaded = 0
    skipped = 0
    for feature in payload["features"]:
        props = feature.get("properties") or {}
        state_code = _normalise_state_code(props, name_to_code)
        if not state_code:
            skipped += 1
            continue
        try:
            geo = json.dumps(_to_multipolygon(feature["geometry"]))
        except ValueError as e:
            print(f"skipping {state_code}: {e}", file=sys.stderr)
            skipped += 1
            continue

        cur.execute(
            """
            INSERT INTO state_boundaries (state_code, geog, source)
            VALUES (%s, ST_GeogFromGeoJSON(%s), %s)
            ON CONFLICT (state_code) DO UPDATE
              SET geog = EXCLUDED.geog,
                  source = EXCLUDED.source,
                  loaded_at = NOW()
            """,
            (state_code, geo, props.get("source") or path),
        )
        loaded += 1

    conn.commit()
    cur.close()
    conn.close()
    print(f"loaded {loaded} state polygons; skipped {skipped}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
