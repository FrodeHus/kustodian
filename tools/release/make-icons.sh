#!/usr/bin/env bash
# Builds Kustodian's icon assets from the logo, assets/logo-source.webp (1254 px, transparent). macOS only (sips and
# iconutil).
#
#   make-icons.sh
#
# The macOS icon keeps the source's padding; everything else uses a tight square crop of the mark, legible at 16 px.
# Writes, and the repository commits:
#   assets/icon.icns                          the macOS bundle icon, from an .iconset of 16 to 1024 px
#   assets/icon-256.png, assets/icon-512.png  the Linux icons (the app embeds icon-256.png as its window icon)
#   tools/release/windows/Assets/Dialog.bmp   the MSI's welcome and finish dialog bitmap, 493x312, icon at left on white
#   tools/release/windows/Assets/Banner.bmp   the MSI's top banner, 493x58, icon at right on white
#   site/favicon.png, site/logo.png           the product website's favicon (32 px) and header logo (28 px at 2x)
#   web/src/shell/logo.png                    the title bar's logo (16 px at 2x)
# and leaves the rendered PNGs (icon-<size>.png) in artifacts/icons/ for make-ico.cs, which writes assets/icon.ico:
#   dotnet run tools/release/make-ico.cs
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
    echo "make-icons.sh: runs on macOS only (sips, iconutil)" >&2
    exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source="$root/assets/logo-source.webp"
assets="$root/assets"
msi="$root/tools/release/windows/Assets"
out="$root/artifacts/icons"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

rm -rf "$out"
mkdir -p "$out" "$msi"

full="$work/full.png"
sips -s format png "$source" --out "$full" >/dev/null
if [[ "$(sips -g pixelWidth "$full" | awk '/pixelWidth/ { print $2 }')" != 1254 ]]; then
    echo "make-icons.sh: the source isn't 1254 px wide; update the crop below" >&2
    exit 1
fi

# The mark's bounding box in the source is about (207,173)-(1094,1085); this square holds it with a small margin.
mark="$work/mark.png"
sips -c 960 960 --cropOffset 149 170 "$full" --out "$mark" >/dev/null

for size in 16 32 48 64 128 256 512; do
    sips -z "$size" "$size" "$mark" --out "$out/icon-$size.png" >/dev/null
done

# macOS: iconutil wants exactly these names, each size at 1x and 2x.
iconset="$work/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$full" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$full" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$assets/icon.icns"

# Linux.
cp "$out/icon-256.png" "$assets/icon-256.png"
cp "$out/icon-512.png" "$assets/icon-512.png"

# The website and the title bar.
cp "$out/icon-32.png" "$root/site/favicon.png"
sips -z 56 56 "$mark" --out "$root/site/logo.png" >/dev/null
cp "$out/icon-32.png" "$root/web/src/shell/logo.png"

# The MSI's bitmaps: the mark placed on a white canvas in an SVG, rendered by sips, then made a BMP. The SVG flattens
# the mark's transparency onto white, which sips can't do.
data="$(base64 <"$out/icon-256.png" | tr -d '\n')"
bitmap() {
    local name="$1" width="$2" height="$3" x="$4" y="$5" size="$6"
    cat >"$work/$name.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="$width" height="$height" viewBox="0 0 $width $height">
  <rect width="$width" height="$height" fill="#ffffff"/>
  <image x="$x" y="$y" width="$size" height="$size" href="data:image/png;base64,$data"/>
</svg>
EOF
    sips -s format png "$work/$name.svg" --out "$work/$name.png" >/dev/null
    sips -s format bmp "$work/$name.png" --out "$msi/$name.bmp" >/dev/null
}
# WiX's welcome dialog shows its text right of a 164 px band, so the icon sits centred in that band.
bitmap Dialog 493 312 22 96 120
# The banner's title and description are at its left, so the icon sits at the right edge.
bitmap Banner 493 58 441 6 46

echo "make-icons.sh: wrote assets/icon.icns, icon-256.png, icon-512.png, the MSI's Dialog.bmp and Banner.bmp, and the" \
    "website and title-bar logos; next: dotnet run tools/release/make-ico.cs" >&2
