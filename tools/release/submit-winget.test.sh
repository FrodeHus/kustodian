#!/usr/bin/env bash
# Tests for tools/release/submit-winget.sh: the winget-pkgs path rule (every dot-separated segment of the identifier is a
# directory level), the pull request title, and the no-token exit. Run: tools/release/submit-winget.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/submit-winget.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

# shellcheck source=SCRIPTDIR/submit-winget.sh
source "$SCRIPT"

[ "$(manifest_path Reothor.Kustodian 1.0.0)" = "manifests/r/Reothor/Kustodian/1.0.0" ] || fail "app path"
[ "$(manifest_path Reothor.Elevate.CLI 1.7.0)" = "manifests/r/Reothor/Elevate/CLI/1.7.0" ] || fail "nested identifier"
[ "$(manifest_path Microsoft.PowerToys 0.80.0)" = "manifests/m/Microsoft/PowerToys/0.80.0" ] || fail "partition is the lower-cased first letter"

[ "$(pr_title Reothor.Kustodian 1.0.0 no)" = "New package: Reothor.Kustodian version 1.0.0" ] || fail "new package title"
[ "$(pr_title Reothor.Kustodian 1.0.1 yes)" = "New version: Reothor.Kustodian version 1.0.1" ] || fail "new version title"

pr_body Reothor.Kustodian 1.0.0 v1.0.0 FrodeHus/kustodian | grep -q 'kustodian/releases/tag/v1.0.0' || fail "body links the release tag"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in Reothor.Kustodian.yaml Reothor.Kustodian.installer.yaml Reothor.Kustodian.locale.en-US.yaml; do echo "x: 1" > "$TMP/$f"; done
out="$(WINGET_TOKEN='' "$SCRIPT" "$TMP" Reothor.Kustodian 1.0.0)" || fail "no token must exit 0"
[[ "$out" == *"WINGET_TOKEN is not set"* ]] || fail "no token must say so: $out"
"$SCRIPT" "$TMP" Reothor.Kustodian 2>/dev/null && fail "wrong argument count must fail" || true

echo "submit-winget: all tests passed"
