#!/usr/bin/env bash
# Download the GRID3 Nigeria Operational Wards layer.
#
# IMPORTANT - dataset selection:
#   The OCHA COD-AB Nigeria dataset (data.humdata.org/dataset/cod-ab-nga)
#   only ships 714 wards at admin level 3 - PARTIAL COVERAGE. Do not use
#   it as the boundary source.
#
#   The full-coverage layer (~8,809 wards) is published separately by
#   GRID3 (Geo-Referenced Infrastructure and Demographic Data for
#   Development) as "Nigeria Operational Wards". It is hosted on:
#     1. GRID3 data portal:  https://data.grid3.org/
#        Search "Nigeria operational wards". Free account required;
#        export as GeoJSON or download the shapefile.
#     2. Humanitarian Data Exchange (HDX), as a separate dataset from
#        cod-ab-nga. Search HDX for: GRID3 Nigeria operational wards
#        https://data.humdata.org/search?q=grid3+nigeria+operational+wards
#
# There is no stable default URL for this script because GRID3 rotates
# the resource UUIDs on republish and the HDX mirror sometimes lags.
# Grab the latest resource link from one of the pages above and pass it
# via WARDS_URL.
#
# Usage:
#   WARDS_URL=https://data.grid3.org/.../wards.geojson \
#     ./scripts/fetch_ward_boundaries.sh
#
#   # or, if you have a shapefile bundle:
#   WARDS_URL=https://.../nga_wards.zip \
#     ./scripts/fetch_ward_boundaries.sh
#   # then convert with: ogr2ogr -f GeoJSON wards.geojson nga_wards.shp
#
# The download lands in data/ward_boundaries/ (gitignored, ~60 MB).
#
# After download:
#   DATABASE_URL=postgresql://... \
#     python scripts/load_ward_boundaries.py data/ward_boundaries/<file>.geojson

set -euo pipefail

DEST_DIR="data/ward_boundaries"
mkdir -p "$DEST_DIR"

if [[ -z "${WARDS_URL:-}" ]]; then
  cat <<'EOF' >&2
WARDS_URL is not set.

The OCHA COD-AB Nigeria dataset only covers 714 wards (partial). For
the full ~8,809-ward layer, get the GRID3 "Nigeria Operational Wards"
resource URL from one of:

  https://data.grid3.org/              (search "operational wards")
  https://data.humdata.org/search?q=grid3+nigeria+operational+wards

Then re-run with:
  WARDS_URL=<that-url> ./scripts/fetch_ward_boundaries.sh
EOF
  exit 2
fi

URL="$WARDS_URL"
OUT="$DEST_DIR/$(basename "$URL")"

echo "Fetching $URL"
echo "  -> $OUT"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 4 --retry-delay 2 -o "$OUT" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget --tries=4 --waitretry=2 -O "$OUT" "$URL"
else
  echo "neither curl nor wget is available" >&2
  exit 2
fi

case "$OUT" in
  *.zip)
    echo "Unzipping into $DEST_DIR"
    unzip -o "$OUT" -d "$DEST_DIR"
    echo
    echo "Shapefile downloaded. Convert to GeoJSON before loading:"
    echo "  ogr2ogr -f GeoJSON $DEST_DIR/wards.geojson $DEST_DIR/<wards>.shp"
    ;;
esac

ls -lh "$DEST_DIR"
echo
echo "Next:"
echo "  DATABASE_URL=postgresql://... \\"
echo "    python scripts/load_ward_boundaries.py $DEST_DIR/<wards>.geojson"
