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

## Pipeline

```bash
# 1. Make sure the wards table is populated.
DATABASE_URL=postgresql://... \
  python scripts/load_polling_units.py Polling-Units/results

# 2. Apply the boundary migration.
psql "$DATABASE_URL" -f db/migrations/0012_ward_boundaries.sql

# 3. Fetch the GRID3 ward GeoJSON. WARDS_URL is required - grab the
#    latest resource URL from data.grid3.org or HDX (NOT cod-ab-nga,
#    that one is partial). See scripts/fetch_ward_boundaries.sh.
WARDS_URL=https://data.grid3.org/.../wards.geojson \
  ./scripts/fetch_ward_boundaries.sh

# 4. (optional) Dry-run reconciliation to see how many wards match
#     before touching the DB.
python scripts/reconcile_ward_names.py \
  data/ward_boundaries/nga_admbnda_adm3.geojson \
  > data/ward_boundaries/reconciliation.csv

# 5. Load polygons. Skips matches below WARD_LOAD_MIN_CONFIDENCE
#     (default 0.90) and writes a per-feature report.
DATABASE_URL=postgresql://... \
  python scripts/load_ward_boundaries.py \
  data/ward_boundaries/nga_admbnda_adm3.geojson
```

The `mvt_wards` tile function picks up polygons immediately because it
joins to `ward_boundaries` on every render, with the existing
centroid as the fallback when a ward is not yet loaded.

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
