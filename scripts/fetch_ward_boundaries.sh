#!/usr/bin/env bash
# Download the GRID3 Nigeria Operational Wards layer.
#
# The dataset is published by GRID3 (Geo-Referenced Infrastructure and
# Demographic Data for Development) and mirrored on the Humanitarian Data
# Exchange as part of OCHA's Common Operational Datasets - Administrative
# Boundaries for Nigeria (slug: cod-ab-nga). It covers all ~8,809 wards
# nationwide at admin level 3.
#
# Source page (browse for the latest resource URL if the default 404s):
#   https://data.humdata.org/dataset/cod-ab-nga
#
# Usage:
#   ./scripts/fetch_ward_boundaries.sh                  # default URL
#   WARDS_URL=https://example.org/path.zip \
#     ./scripts/fetch_ward_boundaries.sh                # override
#
# The downloaded archive (zip or GeoJSON) lands in data/ward_boundaries/.
# This directory is gitignored — the raw file is ~60 MB and re-fetchable.
#
# After download, run:
#   python scripts/load_ward_boundaries.py data/ward_boundaries/<file>.geojson

set -euo pipefail

DEST_DIR="data/ward_boundaries"
mkdir -p "$DEST_DIR"

# HDX resource URL for the COD-AB Nigeria shapefile bundle. The slug is
# stable; the resource UUID can rotate when OCHA republishes, in which
# case override via WARDS_URL.
DEFAULT_URL="https://data.humdata.org/dataset/cod-ab-nga/resource/nga_admbnda_adm3.geojson"
URL="${WARDS_URL:-$DEFAULT_URL}"

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
    ;;
esac

ls -lh "$DEST_DIR"
echo
echo "Next:"
echo "  DATABASE_URL=postgresql://... \\"
echo "    python scripts/load_ward_boundaries.py $DEST_DIR/<wards>.geojson"
