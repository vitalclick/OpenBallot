#!/usr/bin/env bash
# Build web/public/nigeria.topo.json — the unified boundary file the
# /en/map SVG fallback consumes.
#
# Why TopoJSON
#   The previous setup loaded two independently-digitised GeoJSON files
#   (Natural Earth states + OCHA LGAs) on the same SVG. Their borders
#   did not snap, producing visible double-strokes, gaps, and straight
#   lines crossing the coastline. This script derives the state layer
#   *from* the LGA layer by dissolving on `state_code`, which makes the
#   state border exactly equal to the union of LGA borders — alignment
#   is correct by construction. TopoJSON additionally encodes shared
#   LGA-LGA borders only once, eliminating the rest of the artifacts.
#
# Source data
#   GRID3 Nigeria Operational Boundaries (ADM1 + ADM2). Public landing
#   page (no account needed):
#     https://grid3.org/geospatial-data-nigeria
#   Direct dataset links on that page route through the GRID3 Data Hub;
#   pick the "GRID3 NGA - Operational LGA Boundaries" file and export
#   as GeoJSON. CC BY 4.0 attribution is mandatory — surfaced in the
#   map legend.
#
#   For the demo / fresh-clone path we fall back to the OCHA COD-AB LGA
#   file already committed under web/public/nigeria-lgas.geo.json so
#   the page renders out of the box. Operators should re-run this
#   script against the GRID3 ADM2 file once it is downloaded:
#
#     LGAS_INPUT=/path/to/grid3-nga-adm2.geojson \
#       ./scripts/build_nigeria_topojson.sh
#
# Output
#   web/public/nigeria.topo.json — one TopoJSON file containing two
#   objects, `states` (37) and `lgas` (~774). The web/public/nigeria.geo.json
#   and web/public/nigeria-lgas.geo.json files stay in the tree (still
#   used by /en/results) and are NOT touched.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LGAS_INPUT="${LGAS_INPUT:-$repo_root/web/public/nigeria-lgas.geo.json}"
OUTPUT="${OUTPUT:-$repo_root/web/public/nigeria.topo.json}"
SIMPLIFY_INTERVAL="${SIMPLIFY_INTERVAL:-200}"

if [[ ! -f "$LGAS_INPUT" ]]; then
  echo "Missing LGA input: $LGAS_INPUT" >&2
  echo "Set LGAS_INPUT=/path/to/grid3-adm2.geojson or commit a default." >&2
  exit 1
fi

mapshaper_bin=""
for candidate in \
  "$repo_root/web/node_modules/.bin/mapshaper" \
  "$repo_root/node_modules/.bin/mapshaper"; do
  if [[ -x "$candidate" ]]; then
    mapshaper_bin="$candidate"
    break
  fi
done
if [[ -z "$mapshaper_bin" ]]; then
  echo "mapshaper not found. Run: (cd web && npm install)" >&2
  exit 1
fi

echo "Input LGAs:        $LGAS_INPUT"
echo "Simplify interval: ${SIMPLIFY_INTERVAL}m (Visvalingam)"
echo "Output:            $OUTPUT"

# Build pipeline:
#   1. Load LGA GeoJSON as the `lgas` layer.
#   2. Simplify with Visvalingam (topology-preserving) so shared borders
#      between adjacent LGAs stay snapped after coordinate reduction.
#   3. Dissolve a copy of the layer on `state_code` to derive the
#      `states` layer. The state border == union of LGA borders.
#   4. Emit a single TopoJSON with both objects, quantised to 1e5.
"$mapshaper_bin" \
  -i "$LGAS_INPUT" name=lgas \
  -simplify visvalingam interval="$SIMPLIFY_INTERVAL" keep-shapes \
  -dissolve state_code copy-fields=state_name target=lgas + name=states \
  -o format=topojson quantization=100000 target=* "$OUTPUT"

echo "Done. Sizes:"
ls -lh "$OUTPUT"
