#!/usr/bin/env bash
# Rewrites artifacts/SHA256SUMS.txt from every package in artifacts/ (*.msi, *.zip, *.dmg, *.tar.gz, *.AppImage), one
# "<sha256>  <file name>" line per package, sorted by name. Uses sha256sum or shasum -a 256, whichever exists.
#
#   checksums.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifacts="$root/artifacts"

if command -v sha256sum >/dev/null 2>&1; then
    hash=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
    hash=(shasum -a 256)
else
    echo "checksums.sh: neither sha256sum nor shasum is installed" >&2
    exit 1
fi

if [[ ! -d "$artifacts" ]]; then
    echo "checksums.sh: no artifacts folder at $artifacts" >&2
    exit 1
fi
cd "$artifacts"

shopt -s nullglob
packages=(*.msi *.zip *.dmg *.tar.gz *.AppImage)
shopt -u nullglob
if [[ ${#packages[@]} -eq 0 ]]; then
    echo "checksums.sh: no packages in $artifacts" >&2
    exit 1
fi
# Sorted across the patterns (bash 3.2 on macOS has no mapfile).
sorted=()
while IFS= read -r name; do
    sorted+=("$name")
done < <(printf '%s\n' "${packages[@]}" | LC_ALL=C sort)
packages=("${sorted[@]}")

"${hash[@]}" "${packages[@]}" >SHA256SUMS.txt.tmp
mv SHA256SUMS.txt.tmp SHA256SUMS.txt
echo "checksums.sh: wrote $artifacts/SHA256SUMS.txt (${#packages[@]} packages)" >&2
