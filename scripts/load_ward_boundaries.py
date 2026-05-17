#!/usr/bin/env python3
"""Load Nigerian ward polygons into ward_boundaries.

Input: GRID3 / OCHA COD-AB ward GeoJSON (admin level 3). The loader
reconciles each source feature against the INEC `wards` table by name
(see scripts/reconcile_ward_names.py) and upserts the polygon keyed on
the INEC ward code.

Usage:
    DATABASE_URL=postgresql://... \\
        python scripts/load_ward_boundaries.py \\
        data/ward_boundaries/nga_admbnda_adm3.geojson

Flags (env vars):
    WARD_LOAD_MIN_CONFIDENCE   default 0.90 - skip matches below this
    WARD_LOAD_REPORT           default data/ward_boundaries/load_report.csv

The script never touches the `wards` table itself; it only writes to
`ward_boundaries`. Wards must already be loaded via
load_polling_units.py.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from pathlib import Path

import psycopg2

# Importable reconciliation utilities (same directory).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from reconcile_ward_names import (  # noqa: E402
    iter_source_features,
    load_inec_from_db,
    load_overrides,
    reconcile,
)


def _to_multipolygon(geometry: dict) -> dict:
    if geometry["type"] == "MultiPolygon":
        return geometry
    if geometry["type"] == "Polygon":
        return {"type": "MultiPolygon", "coordinates": [geometry["coordinates"]]}
    raise ValueError(f"unsupported geometry type: {geometry['type']}")


def main(geojson_path: str) -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2

    src = Path(geojson_path)
    if not src.exists():
        print(f"GeoJSON not found: {src}", file=sys.stderr)
        return 2

    # Default 0.80 covers fuzzy-LGA + exact-ward matches (e.g. "Damban"
    # vs "Dambam" -> 0.83) and substring LGA matches ("Maiduguri" ⊂
    # "Maiduguri M. C." -> 0.85). Set higher via the env var to demand
    # only near-exact matches; set lower to accept more reconciliation
    # noise (and inspect load_report.csv afterwards).
    min_confidence = float(os.environ.get("WARD_LOAD_MIN_CONFIDENCE", "0.80"))
    report_path = Path(os.environ.get("WARD_LOAD_REPORT", "data/ward_boundaries/load_report.csv"))
    report_path.parent.mkdir(parents=True, exist_ok=True)

    # Connection helper: TCP keepalives stop the Supabase pooler from
    # treating quiet gaps as dead sockets during a multi-thousand-row
    # load; connect_timeout caps stalled DNS / TCP handshake.
    def _connect():
        return psycopg2.connect(
            url,
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
            connect_timeout=15,
        )

    conn = _connect()
    conn.autocommit = False
    cur = conn.cursor()

    inec_wards = load_inec_from_db(conn)
    if not inec_wards:
        print(
            "No rows in wards table. Run scripts/load_polling_units.py first.",
            file=sys.stderr,
        )
        return 2

    overrides = load_overrides(Path("data/ward_boundaries/overrides.csv"))

    # Pre-materialise features so we can iterate twice (once for
    # reconciliation, once for geometry upsert) without re-parsing.
    features = [(p, g) for p, g in iter_source_features(src)]
    matches = reconcile(iter(features), inec_wards, overrides)
    matches_by_id = {m.source_ward_id: m for m in matches}

    loaded = 0
    skipped_no_match = 0
    skipped_low_confidence = 0
    skipped_bad_geom = 0

    # Loop again over features to upsert geometry for accepted matches.
    # iter_source_features yields the same ordering as the property
    # extraction inside reconcile() so we can reuse the same id key.
    from reconcile_ward_names import _first, SOURCE_PROPS

    INSERT_SQL = """
        INSERT INTO ward_boundaries (
          ward_code, geog, source, source_ward_id, match_confidence
        ) VALUES (
          %s, ST_GeomFromGeoJSON(%s)::geography, %s, %s, %s
        )
        ON CONFLICT (ward_code) DO UPDATE
          SET geog = EXCLUDED.geog,
              source = EXCLUDED.source,
              source_ward_id = EXCLUDED.source_ward_id,
              match_confidence = EXCLUDED.match_confidence,
              loaded_at = NOW()
    """
    COMMIT_EVERY = 200

    def _exec_with_retry(params: tuple) -> None:
        """INSERT with reconnect-on-drop. Upserts are idempotent (ON
        CONFLICT DO UPDATE), so a retry after a connection drop is
        safe even when the prior attempt may have partially landed."""
        nonlocal conn, cur
        for attempt in range(1, 5):
            try:
                cur.execute(INSERT_SQL, params)
                return
            except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                if attempt == 4:
                    raise
                backoff = 2 ** (attempt - 1)
                print(
                    f"  connection error on attempt {attempt}/4"
                    f" ({type(e).__name__}); reconnecting in {backoff}s",
                    file=sys.stderr,
                )
                try: cur.close()
                except Exception: pass
                try: conn.close()
                except Exception: pass
                import time; time.sleep(backoff)
                conn = _connect()
                conn.autocommit = False
                cur = conn.cursor()

    with report_path.open("w", newline="") as report_f:
        report = csv.writer(report_f)
        report.writerow([
            "source_ward_id", "source_state", "source_lga", "source_ward",
            "inec_ward_code", "confidence", "reason", "action",
        ])

        for props, geom in features:
            src_id = (
                _first(props, SOURCE_PROPS["ward_id"])
                or f"{_first(props, SOURCE_PROPS['state_name']) or ''}|"
                   f"{_first(props, SOURCE_PROPS['lga_name']) or ''}|"
                   f"{_first(props, SOURCE_PROPS['ward_name']) or ''}"
            )
            m = matches_by_id.get(src_id)
            if m is None or m.inec_ward_code is None:
                skipped_no_match += 1
                if m:
                    report.writerow([
                        m.source_ward_id, m.source_state, m.source_lga, m.source_ward,
                        "", f"{m.confidence:.3f}", m.reason, "skipped_no_match",
                    ])
                continue
            if m.confidence < min_confidence:
                skipped_low_confidence += 1
                report.writerow([
                    m.source_ward_id, m.source_state, m.source_lga, m.source_ward,
                    m.inec_ward_code, f"{m.confidence:.3f}", m.reason, "skipped_low_confidence",
                ])
                continue
            try:
                geo_json = json.dumps(_to_multipolygon(geom))
            except (KeyError, ValueError) as e:
                skipped_bad_geom += 1
                report.writerow([
                    m.source_ward_id, m.source_state, m.source_lga, m.source_ward,
                    m.inec_ward_code, f"{m.confidence:.3f}", m.reason, f"skipped_bad_geom:{e}",
                ])
                continue

            _exec_with_retry(
                (m.inec_ward_code, geo_json, src.name, m.source_ward_id, m.confidence)
            )
            loaded += 1
            if loaded % COMMIT_EVERY == 0:
                conn.commit()
                print(f"  ... {loaded} loaded", file=sys.stderr)
            report.writerow([
                m.source_ward_id, m.source_state, m.source_lga, m.source_ward,
                m.inec_ward_code, f"{m.confidence:.3f}", m.reason, "loaded",
            ])

    conn.commit()
    cur.close()
    conn.close()

    print(
        f"loaded={loaded} "
        f"skipped_no_match={skipped_no_match} "
        f"skipped_low_confidence={skipped_low_confidence} "
        f"skipped_bad_geom={skipped_bad_geom} "
        f"report={report_path}"
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
