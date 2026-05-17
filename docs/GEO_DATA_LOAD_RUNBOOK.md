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

## Related ADRs

- ADR-0011 — Geographic identifiers derived from INEC's `delim`
- ADR-0012 — GRID3 ↔ INEC ward reconciliation strategy
- ADR-0013 — Choropleth fill = leading party at every level
- `docs/WARD_BOUNDARIES.md` — the operator-level docs this runbook
  abridges
