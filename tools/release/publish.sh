#!/usr/bin/env bash
# Publishes Kustodian for one runtime identifier as a single self-contained executable (the publish properties live in
# src/Kustodian/Kustodian.csproj and apply whenever a runtime identifier is given).
#
#   publish.sh <rid> [outdir]
#
# <rid> is one of win-x64, win-arm64, osx-arm64, osx-x64, linux-x64. The default output folder is
# kustodian/artifacts/publish/<rid>/, emptied first. dotnet's output goes to stderr; stdout carries only the output folder.
set -euo pipefail

rids=(win-x64 win-arm64 osx-arm64 osx-x64 linux-x64)

usage() {
    echo "usage: publish.sh <rid> [outdir]   (rid: ${rids[*]})" >&2
}

rid="${1:-}"
known=false
for r in "${rids[@]}"; do
    if [[ "$rid" == "$r" ]]; then
        known=true
    fi
done
if [[ "$known" != true ]]; then
    if [[ -n "$rid" ]]; then
        echo "publish.sh: unknown runtime identifier '$rid'" >&2
    fi
    usage
    exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ $# -ge 2 ]]; then
    mkdir -p "$2"
    out="$(cd "$2" && pwd)"
else
    out="$root/artifacts/publish/$rid"
    rm -rf "$out"
    mkdir -p "$out"
fi

dotnet publish "$root/src/Kustodian/Kustodian.csproj" -c Release -r "$rid" -o "$out" >&2

echo "$out"
