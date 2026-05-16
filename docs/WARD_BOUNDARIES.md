# Ward boundaries

INEC does not publish ward shapes. To render the ward-level choropleth
(zooms 9–11 in `mvt_wards`) with real polygons instead of centroids, the
portal pulls ward boundaries from **GRID3 Nigeria Operational Wards**.
The dataset covers ~8,809 wards nationwide at admin level 3 and is the
de facto reference used by NPC, NBS, and most donor projects.

The polygon table lives in `db/migrations/0012_ward_boundaries.sql`.

## Source — and which dataset NOT to use

There are two HDX entries that look like they fit; only one does.

- **DO NOT USE: OCHA COD-AB Nigeria** (`data.humdata.org/dataset/cod-ab-nga`).
  This dataset's admin-3 layer only covers **714 wards** ("partial
  coverage") — about 8% of the country. It is fine for state / LGA
  but useless as a national ward layer.
- **USE: GRID3 Nigeria Operational Wards**. Full ~8,809-ward national
  coverage. Hosted on:
  - GRID3 data portal: https://data.grid3.org/ (search
    "Nigeria operational wards"; free account required)
  - HDX, as a separate dataset from `cod-ab-nga`. Search HDX for
    `GRID3 Nigeria operational wards`.

Pin the file you load by leaving it on disk under
`data/ward_boundaries/`. GRID3 rotates resource UUIDs on republish, so
`scripts/fetch_ward_boundaries.sh` requires you to supply the resource
URL via `WARDS_URL` rather than baking in a default that will rot.

Licence: GRID3 releases the layer under **CC BY 4.0**. Preserve
attribution to **GRID3** in any public-facing rendering or downloadable
export.

## INEC reconciliation

GRID3 ward features carry an OCHA P-code (e.g. `NGA009007003`) and the
local ward name (e.g. `Itire Ikate`). INEC ward codes follow a different
scheme (e.g. `LA-SUR-04`). There is no published crosswalk, so we join
on the `(state, LGA, ward)` name triple.

Reconciliation lives in `scripts/reconcile_ward_names.py`. The strategy:

1. Normalise names: NFKD strip diacritics, lowercase, drop punctuation,
   collapse whitespace, drop noise tokens (`ward`, `district`, …).
2. Bucket INEC wards by normalised `(state, LGA)`.
3. **Exact match** the normalised ward name inside the LGA bucket. A
   unique hit is confidence 1.0.
4. **Fuzzy fallback** using `difflib.SequenceMatcher` within the same
   LGA. Ratios ≥ 0.90 are auto-accepted; ratios in `[0.75, 0.90)` are
   flagged `needs_review`; below 0.75 they are left unmatched.
5. Operator overrides at `data/ward_boundaries/overrides.csv` win
   unconditionally (confidence 1.0). Columns:
   `source_ward_id,inec_ward_code,note`.

Match confidence is stored in `ward_boundaries.match_confidence` so
dashboards and audits can surface low-confidence reconciliations. The
partial index `idx_ward_boundaries_confidence` makes "show me everything
below 0.9" cheap.

## Local setup — step by step

First-time walkthrough for a fresh clone. The one gotcha up front:
`Polling-Units/results/*.json` ships as empty placeholders, so step 3
has two paths depending on whether you want a real national load
(~8,809 wards) or a smoke test (6 wards from the seed file).

### Prerequisites

- Docker + Docker Compose (for Postgres / PostGIS)
- Python 3.11+
- `git`, `curl`, `unzip`
- `gdal-bin` only if the GRID3 download you grab is a shapefile rather
  than GeoJSON (`brew install gdal` / `apt install gdal-bin`)

### 1. Clone and check out the branch

```bash
git clone https://github.com/vitalclick/OpenBallot.git
cd OpenBallot
git checkout claude/create-nigeria-ward-boundaries-V20iP
```

### 2. Start Postgres and apply migrations

`infra/docker-compose.yml` mounts `db/migrations/` into
`/docker-entrypoint-initdb.d/`, so every migration (including
`0012_ward_boundaries.sql`) and seed runs automatically on first boot:

```bash
docker compose -f infra/docker-compose.yml up -d db
# wait ~10 seconds for the healthcheck to pass

# Verify the new table exists
docker compose -f infra/docker-compose.yml exec db \
  psql -U openballot -d openballot -c "\d ward_boundaries"
```

Export the DB URL for the rest of the session:

```bash
export DATABASE_URL=postgresql://openballot:openballot@localhost:5432/openballot
```

### 3. Populate the `wards` table

Pick one:

**3a. Smoke test (recommended for first run).** Skip ahead. The seed
file `db/seed/01_geo_seed.sql` has already inserted 6 wards across
Lagos / Kano / Rivers / FCT. The reconciler will only match GRID3
features that fall inside those LGAs, but it's enough to see the
pipeline work end-to-end.

**3b. Full national load.** Run the INEC scraper first (takes hours),
then load:

```bash
cd Polling-Units && npm install && node scraper.js && cd ..

python -m venv .venv && source .venv/bin/activate
pip install psycopg2-binary
python scripts/load_polling_units.py Polling-Units/results
```

This populates ~774 LGAs, ~8,809 wards, ~176,000 polling units.

### 4. Set up the Python environment for the loader

```bash
python -m venv .venv && source .venv/bin/activate   # skip if already done
pip install psycopg2-binary
```

### 5. Get the GRID3 ward GeoJSON

The fetch script requires `WARDS_URL`. Get the resource URL from
https://data.grid3.org/ (free account → search "Nigeria Operational
Wards" → copy the GeoJSON download URL). Then:

```bash
WARDS_URL='https://data.grid3.org/.../wards.geojson' \
  ./scripts/fetch_ward_boundaries.sh
```

If the download is a shapefile (`.zip` containing `.shp` + `.dbf` +
`.shx` + `.prj`), convert it after the fetch script unzips it:

```bash
ogr2ogr -f GeoJSON \
  data/ward_boundaries/wards.geojson \
  data/ward_boundaries/<unzipped>.shp
```

### 6. Dry-run reconciliation (optional)

See how many GRID3 wards will match before touching the DB:

```bash
python scripts/reconcile_ward_names.py \
  data/ward_boundaries/wards.geojson \
  > data/ward_boundaries/reconciliation.csv
```

The console prints a summary like
`summary: exact=8210, fuzzy=412, needs_review=87, no_lga=12, no_ward=88`.
Inspect anything labelled `needs_review`, `no_lga`, or `no_ward` in the
CSV. Wrong joins get fixed via `data/ward_boundaries/overrides.csv`:

```csv
source_ward_id,inec_ward_code,note
NGA009007003,LA-SUR-04,grid3 spelling differs from inec
```

### 7. Load polygons into Postgres

```bash
python scripts/load_ward_boundaries.py data/ward_boundaries/wards.geojson
```

Expected output:

```
loaded=8210 skipped_no_match=100 skipped_low_confidence=87 skipped_bad_geom=0 report=data/ward_boundaries/load_report.csv
```

On the smoke-test path, expect `loaded=6` and the rest skipped
`no_match` (the seed wards table only has 6 rows).

### 8. Verify

```bash
docker compose -f infra/docker-compose.yml exec db \
  psql -U openballot -d openballot -c \
  "SELECT count(*), avg(match_confidence)::numeric(4,3) FROM ward_boundaries;"

# Anything low-confidence worth reviewing:
docker compose -f infra/docker-compose.yml exec db \
  psql -U openballot -d openballot -c \
  "SELECT ward_code, source_ward_id, match_confidence
   FROM ward_boundaries WHERE match_confidence < 0.95
   ORDER BY match_confidence LIMIT 20;"
```

### 9. (Optional) See the polygons on the map

```bash
docker compose -f infra/docker-compose.yml up -d
# web at http://localhost:3000 — zoom in to ward level
```

`mvt_wards` now serves your polygons, falling back to centroids for
any ward you didn't load.

### Common errors

| Error | Fix |
|---|---|
| `DATABASE_URL not set` | `export DATABASE_URL=postgresql://openballot:openballot@localhost:5432/openballot` |
| `No rows in wards table` | Run step 3 (seed-only is fine for smoke test) |
| `relation "ward_boundaries" does not exist` | Migration 0012 didn't apply. `docker compose down -v && docker compose up -d db` to re-init. |
| `WARDS_URL is not set` | Step 5 — the fetch script refuses to run with a default; grab the link from data.grid3.org |
| `unsupported geometry type` | Source has a `GeometryCollection`. Pre-process with `ogr2ogr -nlt MULTIPOLYGON`. |

## Reviewing unmatched / low-confidence wards

After a load, inspect:

- `data/ward_boundaries/load_report.csv` — per-feature outcome
- The DB query below — wards with polygons but flagged for review:

```sql
SELECT ward_code, source_ward_id, match_confidence
FROM ward_boundaries
WHERE match_confidence < 0.95
ORDER BY match_confidence;
```

Add entries to `data/ward_boundaries/overrides.csv` and re-run the
loader to fix any incorrect joins. Overrides are idempotent.

## Why not Voronoi?

If GRID3 ever becomes unavailable, the fallback is to generate Voronoi
polygons from INEC polling-unit GPS coordinates and clip to LGA
boundaries. That keeps the map functional but is approximate and is
**not** defensible as "real" ward boundaries — it should only be used
as a stopgap.
