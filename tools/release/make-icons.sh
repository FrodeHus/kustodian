#!/usr/bin/env bash
# Builds Kustodian's icon assets from assets/icon.svg. macOS only (sips, iconutil, and qlmanage when sips can't read SVG).
#
#   make-icons.sh
#
# Writes, and the repository commits:
#   assets/icon.icns                          the macOS bundle icon, from an .iconset of 16 to 1024 px
#   assets/icon-256.png, assets/icon-512.png  the Linux icons (the app embeds icon-256.png as its window icon)
#   tools/release/windows/Assets/Dialog.bmp   the MSI's welcome and finish dialog bitmap, 493x312, icon at left on white
#   tools/release/windows/Assets/Banner.bmp   the MSI's top banner, 493x58, icon at right on white
# and leaves the rendered PNGs (icon-<size>.png) in artifacts/icons/ for make-ico.cs, which writes assets/icon.ico:
#   dotnet run tools/release/make-ico.cs
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
    echo "make-icons.sh: runs on macOS only (sips, iconutil)" >&2
    exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
svg="$root/assets/icon.svg"
assets="$root/assets"
msi="$root/tools/release/windows/Assets"
out="$root/artifacts/icons"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

rm -rf "$out"
mkdir -p "$out" "$msi"

# Renders an SVG to a PNG at the SVG's own size: sips when it can read SVG, else Quick Look's thumbnailer.
render() {
    local src="$1" dest="$2" size="$3"
    if ! sips -s format png "$src" --out "$dest" >/dev/null 2>&1; then
        qlmanage -t -s "$size" -o "$work" "$src" >/dev/null 2>&1
        mv "$work/$(basename "$src").png" "$dest"
    fi
}

master="$out/icon-1024.png"
render "$svg" "$master" 1024
if [[ "$(sips -g pixelWidth "$master" | awk '/pixelWidth/ { print $2 }')" != 1024 ]]; then
    echo "make-icons.sh: the rendered icon isn't 1024 px wide" >&2
    exit 1
fi

for size in 16 32 48 64 128 256 512; do
    sips -z "$size" "$size" "$master" --out "$out/icon-$size.png" >/dev/null
done

# macOS: iconutil wants exactly these names, each size at 1x and 2x.
iconset="$work/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
    cp "$out/icon-$size.png" "$iconset/icon_${size}x${size}.png"
    cp "$out/icon-$((size * 2)).png" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$assets/icon.icns"

# Linux.
cp "$out/icon-256.png" "$assets/icon-256.png"
cp "$out/icon-512.png" "$assets/icon-512.png"

# The MSI's bitmaps: the mark (icon.svg without its outer <svg> element) placed on a white canvas, rendered, then made a BMP.
mark="$(sed -e '1d' -e '$d' "$svg")"
bitmap() {
    local name="$1" width="$2" height="$3" x="$4" y="$5" size="$6"
    cat >"$work/$name.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="$width" height="$height" viewBox="0 0 $width $height">
  <rect width="$width" height="$height" fill="#ffffff"/>
  <svg x="$x" y="$y" width="$size" height="$size" viewBox="0 0 1024 1024">
$mark
  </svg>
</svg>
EOF
    render "$work/$name.svg" "$work/$name.png" "$width"
    sips -s format bmp "$work/$name.png" --out "$msi/$name.bmp" >/dev/null
}
# WiX's welcome dialog shows its text right of a 164 px band, so the icon sits centred in that band.
bitmap Dialog 493 312 22 96 120
# The banner's title and description are at its left, so the icon sits at the right edge.
bitmap Banner 493 58 441 6 46

echo "make-icons.sh: wrote assets/icon.icns, assets/icon-256.png, assets/icon-512.png," \
    "tools/release/windows/Assets/Dialog.bmp and Banner.bmp; next: dotnet run tools/release/make-ico.cs" >&2
