#!/usr/bin/env bash
set -euo pipefail

# ---- CONFIG ----
IMG_ROOT="/Users/burhananis/phd-july25/images"           # where your test_*.tif live
PKL="/Users/burhananis/phd-fully-supervised/level_2_results/level_2_exp4/slide_index_test.pkl"             # your predictions PKL
SITE_ROOT="/Users/burhananis/pathology-viewer"           # web app root (has index.html/app.js)
TILE=256
OVERLAP=0

cd "$SITE_ROOT"

# fresh index
echo '{ "slides": [] }' > slides_index.json

# function to append to slides_index.json (needs jq)
append_index () {
  local SID="$1"
  jq --arg id "$SID" \
     --arg name "$SID" \
     --arg manifest "slides/$SID/manifest.json" \
     '.slides += [{"id":$id,"name":$name,"manifest":$manifest}]' \
     slides_index.json > slides_index.tmp && mv slides_index.tmp slides_index.json
}

# loop over slides that start with test_*.tif
find "$IMG_ROOT" -type f -name 'test_*.tif' -print0 | while IFS= read -r -d '' slide; do
  SID="$(basename "$slide" .tif)"
  echo "==> Processing $SID"

  mkdir -p "slides/$SID"

  # 1) BASE tiles from WSI level 2 (NO --depth=one)
  vips dzsave "${slide}[level=2]" \
    "slides/$SID/base" \
    --tile-size=$TILE --overlap=$OVERLAP --suffix=.png

  # 2) OVERLAY PNG @ L2 (your script writes overlay_l2.png to out-dir)
  python make-overlay.py \
    --pkl "$PKL" \
    --slide-id "$SID" \
    --base-dzi "slides/$SID/base.dzi" \
    --out-dir "slides/$SID" \
    --alpha-mode value

  # If your script outputs a different filename, change this:
  OVERLAY_PNG="slides/$SID/overlay.png"
  [ -f "$OVERLAY_PNG" ] || { echo "Missing $OVERLAY_PNG"; exit 1; }

  # 3) OVERLAY tiles (NO --depth=one)
  vips dzsave "$OVERLAY_PNG" \
    "slides/$SID/overlay" \
    --tile-size=$TILE --overlap=$OVERLAP --suffix=.png

  # 4) Per-slide manifest
  cat > "slides/$SID/manifest.json" <<EOF
{
  "id": "$SID",
  "name": "$SID",
  "tileSize": $TILE,
  "overlap": $OVERLAP,
  "base":    { "dzi": "./base.dzi" },
  "overlay": { "dzi": "./overlay.dzi", "alpha": 0.5, "valueRange": [0,1] }
}
EOF

  # 5) Add to overall index
  append_index "$SID"
done

echo "All done. slides_index.json built."
