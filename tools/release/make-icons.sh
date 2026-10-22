#!/usr/bin/env bash
# Builds every logo and icon file from assets/logo-source.webp. Run on macOS (sips, iconutil) with the .NET SDK; commit the
# results. The source keeps its padding for the macOS icon; everything else uses a tight square crop, legible at 16 px.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source="$root/assets/logo-source.webp"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The mark's bounding box in the 1254 px source is about (207,173)-(1094,1085); this square holds it with a small margin.
sips -s format png "$source" --out "$work/full.png" >/dev/null
sips -c 960 960 --cropOffset 149 170 "$work/full.png" --out "$work/mark.png" >/dev/null

# png <master> <size> <out>
png() {
    sips -z "$2" "$2" "$1" --out "$3" >/dev/null
}

# macOS: an .icns from an iconset of 16 to 1024 px.
iconset="$work/icon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
    png "$work/full.png" "$size" "$iconset/icon_${size}x${size}.png"
    png "$work/full.png" $((size * 2)) "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$root/assets/icon.icns"

# Linux, and the window icon on Windows and Linux.
png "$work/mark.png" 256 "$root/assets/icon-256.png"
png "$work/mark.png" 512 "$root/assets/icon-512.png"

# Windows: the executable's icon.
for size in 16 32 48; do
    png "$work/mark.png" "$size" "$work/ico-$size.png"
done
dotnet run "$root/tools/release/make-ico.cs" -- "$root/assets/icon.ico" \
    "$work/ico-16.png" "$work/ico-32.png" "$work/ico-48.png" "$root/assets/icon-256.png"

# The product website: the favicon and the 28 px logo in the header, at twice its size.
png "$work/mark.png" 32 "$root/site/favicon.png"
png "$work/mark.png" 56 "$root/site/logo.png"

# The app's title bar shows the logo at 16 px.
png "$work/mark.png" 32 "$root/web/src/shell/logo.png"
