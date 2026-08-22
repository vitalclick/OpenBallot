# Geographic data load runbook

End-to-end procedure for populating a fresh Supabase project with
Nigeria's polling unit roster and ward boundaries. Distilled from the
May 2026 load; re-run with refreshed inputs each election cycle.

The dependency order matters: states ← LGAs ← wards ← polling units
← ward boundaries. The fast path is two scripts, ~5 minutes of human
attention plus ~2 hours of unattended runtime.

## Prerequisites

- A Supabase project with `db/migrations/0001` through latest
  applied.
- `DATABASE_URL` pointing at the project's **session-mode pooler**
  (port 5432, host `aws-0-<region>.pooler.supabase.com`). Not the
  raw direct-connect URL (IPv6-only on free tier) and not the
  transaction pooler (port 6543; long-running session features
  unreliable).
- Python 3.11+ with `psycopg2-binary` installed.
- Node.js 20+ for the scraper.

## Step 1 — Scrape INEC polling units

```bash
cd Polling-Units
node scraper.js --reset   # ~60 minutes; ~88 MB of JSON output
```

Outputs in `Polling-Units/results/`:
- `<state>.json` × 37
- `summary.json` — totals + failure log
- `all-polling-units.json` — merged flat list

Verify `summary.json` shows:
- `totals.states: 37`, `totals.lgas: 774`
- `failures: 0` (a small non-zero is OK; see "Rescrape failed wards"
  below)

If a state has failures, delete it from `progress/scrape_progress.json`
and re-run `node scraper.js` (no `--reset`). Failures are usually
transient DNS hiccups affecting one LGA's worth of wards.

The scrape data is **committed to the repo** as a versioned snapshot,
not gitignored. See ADR-0011 for the rationale.

## Step 2 — Load polling units into Postgres

```bash
DATABASE_URL=... python scripts/load_polling_units.py
```

Reads from `Polling-Units/results/`. Pre-flight pass verifies every
PU's `delim` is globally unique (defuses the scraper's "delim
repeats" warning). Then loads state → LGA → ward → PU in dependency
order, with a separate transaction per state and reconnect-on-drop
retry.

Expected output:
```
Pre-flight OK: 174,175 PUs, 174,175 unique delims, no collisions.
  abia.json: 17 LGAs, 184 wards, 4041 PUs
  ...
Done: 773 LGAs, 8,712 wards, 174,175 polling units
```

(One LGA is below 774 because INEC's Borno / Abadam has zero PUs in
the published roster; the loader correctly skips it.)

If the Supabase pooler drops the connection mid-load, the loader
reconnects and continues from the next state. Re-running from
scratch is also safe — every upsert is `ON CONFLICT DO UPDATE`.

## Step 2b — Enrich coordinates and registered voters

> Input and attribution: `data/pu-enrichment-2023/SOURCES.md`. Licensing
> was agreed with CCIJ; every figure derived from it must be attributed
> to them wherever it is published.

INEC's roster carries neither GPS coordinates nor registered-voter
counts, so after step 2 `polling_units.geog` and `registered_voters`
are NULL for every row. Until they are populated the GPS geofence in
`worker/app/ingestion/geofence.py` cannot make a decision: it is live
code that never fires.

```bash
# Parse and report without touching the database:
python scripts/load_pu_enrichment.py \
    --roster data/pu-enrichment-2023/pu_roster.csv \
    --voter-info data/pu-enrichment-2023/pu_results_2023.csv \
    --dry-run --report /tmp/rejects.csv

# Apply. --create-missing-lgas is needed for Borno / Abadam, whose
# polling units INEC's roster omits entirely:
DATABASE_URL=... python scripts/load_pu_enrichment.py \
    --roster data/pu-enrichment-2023/pu_roster.csv \
    --voter-info data/pu-enrichment-2023/pu_results_2023.csv \
    --create-missing-lgas
```

Requires migration `0017_pu_geo_provenance.sql`.

Takes about four minutes against a local Postgres. Expected output:

```
Gap fill: 2,671 polling units absent from the registry, across 97 wards
          (97 of them new), 1 LGAs missing
  created LGA BO-01: Abadam (BO)
  LGAs created: 1   wards created: 97   polling units inserted: 2,671
Enrichment: 176,526 polling units (155,984 exact, 20,542 shared_site);
            176,846 with registered-voter counts
```

After it, the registry matches every count in INEC's own report — 37
states, 774 LGAs, 8,809 wards, 176,846 polling units.

Two passes run by default, either of which can be skipped with
`--no-gap-fill` / `--no-enrich`:

**Gap fill** inserts wards and polling units absent from our registry.
`Polling-Units/reconciliation/RECONCILIATION-2023.md` records a
2,671-PU deficit against INEC's own published count that INEC's API
cannot supply — those wards return zero polling units from it. Rows
inserted here carry `source = 'ccij_2023'` (or whatever `--source`
says), so they stay distinguishable from INEC-enumerated geography.

**Enrichment** populates `geog`, `registered_voters` and their
provenance columns for polling units we already have.

### Coordinate precision — read before tightening the fence

The loader labels every coordinate `exact` or `shared_site`. Co-located
polling units — several in one school or market — resolve to a single
point in the sources we have seen. In the CCIJ roster that is 20,542
polling units, 11.6% of those mapped.

`shared_site` coordinates are **not** used for hard rejects. An agent
standing at the correct polling unit can be hundreds of metres from a
shared point, and a hard reject is the one ingestion outcome with no
recovery path: the EC8A is refused and goes back in the folder. The
distance is still measured and flagged, so a reviewer sees it.

If a future source supplies surveyed per-PU positions, load them with
`geog_precision = 'exact'` and the hard fence starts applying to them
automatically. Nothing else needs to change.

### Verify

```sql
SELECT geog_source, geog_precision, count(*)
  FROM polling_units WHERE geog IS NOT NULL
 GROUP BY 1, 2 ORDER BY 1, 2;

-- 93,299,647 from this source, 0.18% below INEC's published
-- 93,469,008. The shortfall is in the source and is not corrected.
SELECT sum(registered_voters) FROM polling_units;
```

Rejected rows are never loaded silently. `--report` writes them with a
reason per row: `malformed_pu_code`, `duplicate_pu_code`,
`missing_coordinate`, `coordinate_outside_nigeria`,
`missing_registered_voters`.

The loader is idempotent — re-running against the same input leaves the
registry byte-identical. Before writing anything it aborts with exit 3 if a polling unit sits in a
state the registry lacks, and with exit 4 if an LGA is missing and
`--create-missing-lgas` was not given.

## Step 3 — Apply the ward polygon API migration

```bash
psql "$DATABASE_URL" -f db/migrations/0014_ward_polygons_api.sql
```

Or paste into the Supabase SQL editor. Creates
`fn_lga_ward_polygons(p_lga TEXT)`, the function the
`/api/v1/lgas/{code}/wards` endpoint calls. No data change.

## Step 4 — Download GRID3 ward layers

Go to <https://grid3.org/geospatial-data-nigeria> (or click through
to the GRID3 Data Hub). Download **both**:

- **v1.0 (Dec 2020)** — all 37 states, ~28 MB GeoJSON. Save to
  `data/ward_boundaries/wards_v1.geojson`.
- **v2.0 (Apr 2026 or latest)** — 15 states only, ~260 MB. Save as
  the filename GRID3 ships (do not rename — useful for
  provenance in the `source` column).

GRID3 rotates resource UUIDs on republish, so we don't bake a URL
into the fetch script. The two files are large; gitignored under
`data/ward_boundaries/*` except for `README.md`.

## Step 5 — Load both vintages, v1.0 first

```bash
DATABASE_URL=... python scripts/load_ward_boundaries.py \
    data/ward_boundaries/wards_v1.geojson

DATABASE_URL=... python scripts/load_ward_boundaries.py \
    data/ward_boundaries/main_GRID3_NGA_operational_wards_v2_0_*.geojson
```

Load order matters: `ON CONFLICT (ward_code) DO UPDATE` means the
second file's polygons overwrite the first's for shared wards, and
v2.0 is the newer / cleaner data for the 15 states it covers.

Expected (current May 2026 vintages):
- v1.0: `loaded=6,159 skipped_no_match=2,976 skipped_low_confidence=260`
- v2.0: `loaded=3,493 skipped_no_match=511 skipped_low_confidence=40`
- DB total after both: ~6,170 unique ward polygons (~71% of 8,712)

A `data/ward_boundaries/load_report.csv` is overwritten after each
load — keep a copy if you want to diff. The report carries one row
per source feature with the matched INEC ward code, confidence, and
reason (`exact`, `lga_fuzzy_exact_ward`, `fuzzy`, `needs_review`,
`no_ward`, `no_lga`, `ambiguous`).

## Step 6 — Verify

```sql
-- Totals
SELECT
  (SELECT COUNT(*) FROM states)         AS states,           -- 37
  (SELECT COUNT(*) FROM lgas)           AS lgas,             -- 773
  (SELECT COUNT(*) FROM wards)          AS wards,            -- 8712
  (SELECT COUNT(*) FROM polling_units)  AS polling_units,    -- 174175
  (SELECT COUNT(*) FROM ward_boundaries) AS polygons;        -- ~6170

-- Per-state polygon coverage
SELECT
  s.code, s.name,
  COUNT(w.code)                                                       AS wards,
  COUNT(wb.ward_code)                                                 AS with_polygon,
  ROUND(100.0 * COUNT(wb.ward_code) / NULLIF(COUNT(w.code), 0), 1)    AS pct
FROM states s
JOIN lgas l ON l.state_code = s.code
JOIN wards w ON w.lga_code = l.code
LEFT JOIN ward_boundaries wb ON wb.ward_code = w.code
GROUP BY s.code, s.name
ORDER BY pct DESC;
```

The 15 v2.0-covered states should land at 75-100%. The 22 v1.0-only
states will be mixed (Kebbi 95% if the `KB` alias loaded; southern
states 12-50%).

## Step 7 — Verify on the live map

```bash
cd web && npm run dev
# open http://localhost:3000/en/results
```

- Country focus → 37 state polygons, each filled by the leading
  party (or grey for "no result yet")
- Click a state → LGA polygons in the same scheme
- Click an LGA → ward polygons (where GRID3-covered) + circle
  fallbacks (elsewhere), all party-tinted
- Click a ward → PU dots, each party-tinted

If the map shows mostly grey: there are no election results in the
DB yet. The geo skeleton is loaded; results flow in from EC8A
submissions separately.

## Refresh cycle

Re-run when:
- **INEC publishes a roster update** — re-do steps 1–2. Upsert
  semantics keep existing PU rows; new rows appear; merged wards
  consolidate into one INEC code (the old one's PUs become
  orphans, addressable via the `source = 'inec_scrape'` filter).
- **GRID3 ships a v2.x update** — re-do steps 4–5 with the new file.
  The loader's `ON CONFLICT DO UPDATE` swaps in the newer polygon
  for matched wards. No code change needed.
- **A new state code or LGA alias is needed** — edit
  `GRID3_TO_INEC_STATE_CODE` or `LGA_NAME_ALIASES` in
  `scripts/reconcile_ward_names.py`, re-run step 5.
- **A better coordinate source becomes available** — re-run step
  2b with it. Enrichment is an upsert; a coordinate carrying a
  higher precision supersedes a `shared_site` one.

## Related ADRs

- ADR-0011 — Geographic identifiers derived from INEC's `delim`
- ADR-0012 — GRID3 ↔ INEC ward reconciliation strategy
- ADR-0013 — Choropleth fill = leading party at every level
- `docs/WARD_BOUNDARIES.md` — the operator-level docs this runbook
  abridges
