# Map Boundary Data

The public `/en/map` page renders four levels of Nigerian admin
geography (country → state → LGA → ward → polling unit). The first
three levels are polygon boundaries that must be **topologically
consistent** — the union of LGA polygons in a state has to equal the
state polygon, otherwise the renderer shows double-strokes and gaps.

## Source of truth

**GRID3 Nigeria Operational Boundaries** for ADM1/ADM2 (states and
LGAs), and **GRID3 Nigeria Operational Wards** for ADM3 (wards).
GRID3 publishes all three layers from a single topology, so the
levels snap by construction. CC BY 4.0; attribution surfaced in the
map legend ("Boundaries © GRID3 (CC BY 4.0)").

Public landing page (no account required):
**https://grid3.org/geospatial-data-nigeria**

The page links directly to:

- `GRID3 NGA – Operational State Boundaries` (Dec 2020) — ADM1, 37 features
- `GRID3 NGA – Operational LGA Boundaries` (Dec 2020) — ADM2, 774 features
- `GRID3 NGA – Operational Wards v2.0` (Apr 2026) — partial state coverage
- `GRID3 NGA – Operational Wards v1.0` (Dec 2020) — all states; v2.0 supersedes per-listed-state

Each link routes through the GRID3 Data Hub (data.grid3.org). On the
dataset page, use the **Download** dropdown and pick **GeoJSON**
(Shapefile also works but requires a one-step conversion). HDX
mirror: https://data.humdata.org/ search "grid3 nigeria".

## Why TopoJSON

The two GeoJSON files that previously shipped under
`web/public/nigeria.geo.json` (Natural Earth 1:10m states) and
`web/public/nigeria-lgas.geo.json` (OCHA COD-AB LGAs) were digitised
from different sources at different precisions. Drawing both on the
same SVG produced visibly misaligned state borders and LGA borders.

The fix is structural, not cosmetic:

1. We derive the state layer **from** the LGA layer by dissolving on
   `state_code`. The resulting state border is mathematically the
   union of LGA borders.
2. We emit the result as **TopoJSON**, which represents every shared
   border only once as an arc. Adjacent LGAs share the arc between
   them — no double-stroke artifacts, ~50 % smaller payload than the
   equivalent GeoJSON pair.

## Build

`scripts/build_nigeria_topojson.sh` runs `mapshaper` to produce
`web/public/nigeria.topo.json`. Defaults to the existing OCHA LGA
file so a fresh clone renders out of the box; override with GRID3:

```bash
LGAS_INPUT=/path/to/grid3-nga-adm2.geojson \
  ./scripts/build_nigeria_topojson.sh
```

Options:

- `LGAS_INPUT` — source GeoJSON. Must have `state_code` (or
  ADM1_PCODE) and `state_name` per feature. Default:
  `web/public/nigeria-lgas.geo.json`.
- `SIMPLIFY_INTERVAL` — Visvalingam interval in metres. Default 200,
  which keeps borders crisp at typical zoom and trims ~40 % of
  coordinates. Lower for higher fidelity, higher for smaller files.
- `OUTPUT` — destination file. Default
  `web/public/nigeria.topo.json`.

## What the SVG consumer expects

`web/components/ResultsMap.tsx` loads `/nigeria.topo.json` once on
mount and converts each object back to a GeoJSON FeatureCollection
via `topojson-client`'s `feature()`. State features get a synthesised
`iso = "NG-" + state_code` so the existing render code (which keys
off the ISO 3166-2 code) keeps working unchanged.

## Server-side polygons

`db/migrations/0011_state_boundaries.sql` and
`db/migrations/0012_ward_boundaries.sql` define
`state_boundaries` / `lga_boundaries` / `ward_boundaries` tables
plus the `mvt_*` tile functions. For Mapbox-token deployments the
tiles come from these tables — populate them via
`scripts/load_state_polygons.py` / `scripts/load_ward_boundaries.py`,
ideally from the same GRID3 release that the client TopoJSON was
built from.
