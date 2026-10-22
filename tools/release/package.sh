#!/usr/bin/env bash
# The single entry point for packaging Kustodian for one runtime identifier:
#   1. publish.sh <rid> (into artifacts/publish/<rid>/);
#   2. smoke.sh on the published executable, when <rid> is the build machine's own (macOS and Linux);
#   3. the platform's packaging function, which writes the package(s) into artifacts/;
#   4. checksums.sh, which rewrites artifacts/SHA256SUMS.txt.
#
#   package.sh <rid>
#
# <rid> is one of win-x64, win-arm64, osx-arm64, osx-x64, linux-x64. The version is the project's (Directory.Build.props).
# The Windows MSIs are built on Windows by tools/release/windows/build.ps1; this script makes the portable zips.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release="$root/tools/release"
artifacts="$root/artifacts"

usage() {
    echo "usage: package.sh <rid>   (rid: win-x64 win-arm64 osx-arm64 osx-x64 linux-x64)" >&2
}

# The build machine's runtime identifier where smoke.sh can run (macOS and Linux), else nothing.
host_rid() {
    local os arch
    case "$(uname -s)" in
        Darwin) os=osx ;;
        Linux) os=linux ;;
        *) return 0 ;;
    esac
    case "$(uname -m)" in
        arm64 | aarch64) arch=arm64 ;;
        x86_64 | amd64) arch=x64 ;;
        *) return 0 ;;
    esac
    echo "$os-$arch"
}

project_version() {
    dotnet msbuild "$root/src/Kustodian/Kustodian.csproj" -getProperty:Version | tr -d '[:space:]'
}

# Kustodian-<version>-<rid>.zip: Kustodian.exe, LICENSE and README.md at the top level.
package_windows() {
    local rid="$1" publish="$2" version="$3"
    local zip="$artifacts/Kustodian-$version-$rid.zip"
    if ! command -v zip >/dev/null 2>&1; then
        echo "package.sh: zip is not installed" >&2
        exit 1
    fi
    if [[ ! -f "$publish/Kustodian.exe" ]]; then
        echo "package.sh: $publish/Kustodian.exe is missing after publish" >&2
        exit 1
    fi
    rm -f "$zip"
    zip -j -X -q "$zip" "$publish/Kustodian.exe" "$root/LICENSE" "$root/README.md"
    echo "package.sh: wrote $zip" >&2
}

rid="${1:-}"
case "$rid" in
    win-x64 | win-arm64) platform=windows ;;
    osx-arm64 | osx-x64 | linux-x64)
        echo "package.sh: packaging for $rid is not implemented yet" >&2
        exit 2
        ;;
    *)
        if [[ -n "$rid" ]]; then
            echo "package.sh: unknown runtime identifier '$rid'" >&2
        fi
        usage
        exit 2
        ;;
esac

version="$(project_version)"
if [[ -z "$version" ]]; then
    echo "package.sh: could not read the project version" >&2
    exit 1
fi

publish="$("$release/publish.sh" "$rid")"

if [[ "$rid" == "$(host_rid)" ]]; then
    exe="$publish/Kustodian"
    "$release/smoke.sh" "$exe"
fi

mkdir -p "$artifacts"
"package_$platform" "$rid" "$publish" "$version"

"$release/checksums.sh"
