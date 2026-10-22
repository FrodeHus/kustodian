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

# The macOS staging folder; removed on any exit, including a failure under set -e.
work=""
trap '[[ -z "$work" ]] || rm -rf "$work"' EXIT

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

# The minimum macOS .NET 10 supports (https://learn.microsoft.com/dotnet/core/install/macos: macOS 14 "Sonoma" and later).
macos_min_version="14.0"

# Kustodian.app (ad-hoc signed) inside Kustodian-<version>-<rid>.zip and Kustodian-<version>-<rid>.dmg.
package_macos() {
    local rid="$1" publish="$2" version="$3"
    local zip="$artifacts/Kustodian-$version-$rid.zip" dmg="$artifacts/Kustodian-$version-$rid.dmg"
    if [[ ! -f "$publish/Kustodian" ]]; then
        echo "package.sh: $publish/Kustodian is missing after publish" >&2
        exit 1
    fi
    work="$(mktemp -d)"
    local app="$work/stage/Kustodian.app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp "$publish/Kustodian" "$app/Contents/MacOS/Kustodian"
    chmod +x "$app/Contents/MacOS/Kustodian"
    cp "$root/assets/icon.icns" "$app/Contents/Resources/icon.icns"
    sed -e "s/@VERSION@/$version/g" -e "s/@MINOS@/$macos_min_version/g" "$release/macos/Info.plist.in" \
        >"$app/Contents/Info.plist"
    plutil -lint "$app/Contents/Info.plist" >&2

    # Apple Silicon refuses to run unsigned arm64 code, so the bundle gets an ad-hoc signature.
    codesign --force --deep --sign - "$app" >&2
    codesign --verify --deep --strict "$app" >&2

    rm -f "$zip" "$dmg"
    ditto -c -k --keepParent "$app" "$zip"
    echo "package.sh: wrote $zip" >&2

    ln -s /Applications "$work/stage/Applications"
    hdiutil create -volname Kustodian -srcfolder "$work/stage" -ov -format UDZO "$dmg" >&2
    echo "package.sh: wrote $dmg" >&2
}

rid="${1:-}"
case "$rid" in
    win-x64 | win-arm64) platform=windows ;;
    osx-arm64 | osx-x64)
        if [[ "$(uname -s)" != "Darwin" ]]; then
            echo "package.sh: the macOS packages are built on macOS only" >&2
            exit 2
        fi
        platform=macos
        ;;
    linux-x64)
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
