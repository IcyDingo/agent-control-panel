#!/bin/bash
# Renders app/icon.svg into app/icons/<size>x<size>.png, the icons the Linux app is packaged with (electron-builder.yml)
# and shows in its window and tray (desktop/main.mjs). Run it on a Mac after icon.svg changes, and commit the PNGs:
# the Linux build has no SVG renderer of its own.
#
# icon.svg sits in macOS's icon grid, with a 100 px margin round the tile. Linux launchers draw icons edge to edge, so
# the same drawing is cropped to a 36 px margin first: the tile is then as large as its neighbours'.
set -euo pipefail
cd "$(dirname "$0")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sed 's/viewBox="0 0 1024 1024"/viewBox="64 64 896 896"/' icon.svg > "$work/icon.svg"
grep -q 'viewBox="64 64 896 896"' "$work/icon.svg" || { echo "icon.svg's viewBox is no longer 0 0 1024 1024: adjust the crop here" >&2; exit 1; }
swift render-icon.swift "$work/icon.svg" "$work/out.iconset"

mkdir -p icons
rm -f icons/*.png
for size in 16 32 128 256 512; do cp "$work/out.iconset/icon_${size}x${size}.png" "icons/${size}x${size}.png"; done
cp "$work/out.iconset/icon_32x32@2x.png" icons/64x64.png
cp "$work/out.iconset/icon_512x512@2x.png" icons/1024x1024.png
ls -1 icons
