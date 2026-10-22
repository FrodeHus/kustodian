#!/usr/bin/env bash
# Prepares the release commit for <version>: moves the entries under "## [Unreleased]" in CHANGELOG.md to a new
# "## [<version>] - <date>" section and sets <Version> in Directory.Build.props. The release workflow runs it by hand
# before it commits and tags; it works the same locally.
#
#   cut-release.sh <version> [date]
#
# <version> is x.y.z, without the tag's "v". <date> is YYYY-MM-DD, today (UTC) when omitted. Fails when Unreleased is
# empty or the version already has a section, so a release can't be cut with nothing to say or cut twice.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "usage: cut-release.sh <version> [date]" >&2
    exit 2
fi

version="$1"
date="${2:-$(date -u +%Y-%m-%d)}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
changelog="$root/CHANGELOG.md"
props="$root/Directory.Build.props"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "cut-release.sh: version must be x.y.z, got '$version'" >&2
    exit 2
fi
if ! [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "cut-release.sh: date must be YYYY-MM-DD, got '$date'" >&2
    exit 2
fi
if ! grep -q '^## \[Unreleased\]' "$changelog"; then
    echo "cut-release.sh: CHANGELOG.md has no \"## [Unreleased]\" section" >&2
    exit 1
fi
if grep -qF "## [$version]" "$changelog"; then
    echo "cut-release.sh: CHANGELOG.md already has a section for $version" >&2
    exit 1
fi

# The Unreleased body: everything between its heading and the next "## " heading.
body="$(awk '/^## \[Unreleased\]/ { on = 1; next } /^## / { on = 0 } on' "$changelog")"
if [[ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]]; then
    echo "cut-release.sh: CHANGELOG.md has nothing under Unreleased; add the release notes first" >&2
    exit 1
fi
if [[ "$(grep -c '<Version>[^<]*</Version>' "$props")" != "1" ]]; then
    echo "cut-release.sh: Directory.Build.props must have exactly one <Version>" >&2
    exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

awk -v v="$version" -v d="$date" '
    /^## \[Unreleased\]/ { print; print ""; print "## [" v "] - " d; next }
    { print }
' "$changelog" >"$tmp"
# Collapse the blank lines the move can leave between the Unreleased heading and the new one.
awk 'NR == 1 || !(/^$/ && prev ~ /^$/) { print } { prev = $0 }' "$tmp" >"$changelog"

sed -E "s#<Version>[^<]*</Version>#<Version>$version</Version>#" "$props" >"$tmp"
cat "$tmp" >"$props"

echo "Cut $version ($date): CHANGELOG.md and Directory.Build.props"
