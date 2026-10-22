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

# The macOS and Linux staging folder; removed on any exit, including a failure under set -e.
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

# A Python that can write zips, for hosts without zip (Git Bash on Windows, where `python3` may be the Microsoft Store
# stub that fails to run); prints nothing when there is none.
zip_python() {
    local py
    for py in python3 python; do
        if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import zipfile' >/dev/null 2>&1; then
            echo "$py"
            return 0
        fi
    done
}

# Kustodian-<version>-<rid>.zip: Kustodian.exe, LICENSE and README.md at the top level. Uses zip, or Python's zipfile
# where zip is missing (Git Bash on the Windows release runner has no zip).
package_windows() {
    local rid="$1" publish="$2" version="$3"
    local zip="$artifacts/Kustodian-$version-$rid.zip" py=""
    if ! command -v zip >/dev/null 2>&1; then
        py="$(zip_python)"
        if [[ -z "$py" ]]; then
            echo "package.sh: neither zip nor Python is installed" >&2
            exit 1
        fi
    fi
    if [[ ! -f "$publish/Kustodian.exe" ]]; then
        echo "package.sh: $publish/Kustodian.exe is missing after publish" >&2
        exit 1
    fi
    rm -f "$zip"
    local files=("$publish/Kustodian.exe" "$root/LICENSE" "$root/README.md")
    if [[ -z "$py" ]]; then
        zip -j -X -q "$zip" "${files[@]}"
    else
        "$py" - "$zip" "${files[@]}" <<'PY'
import os
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sys.argv[2:]:
        archive.write(path, os.path.basename(path))
PY
    fi
    echo "package.sh: wrote $zip" >&2
}

# The minimum macOS .NET 10 supports (https://learn.microsoft.com/dotnet/core/install/macos: macOS 14 "Sonoma" and later).
macos_min_version="14.0"

# Developer ID signing, when MACOS_SIGN_IDENTITY names a certificate in the keychain (the release workflow sets
# "Developer ID Application"); notarization as well when APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD are all set.
# Without MACOS_SIGN_IDENTITY the bundle gets an ad-hoc signature.
macos_sign_identity="${MACOS_SIGN_IDENTITY:-}"

macos_can_notarize() {
    [[ -n "$macos_sign_identity" && -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]
}

# Submits <file> (a zip, dmg or pkg) to the notary service, waits for the verdict and stops unless it is Accepted. The
# service's log, which lists every issue it found, is printed either way.
notarize() {
    local file="$1" result id status
    local auth=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD")
    result="$(xcrun notarytool submit "$file" "${auth[@]}" --wait --output-format json)" || true
    id="$(plutil -extract id raw - <<<"$result" 2>/dev/null || true)"
    status="$(plutil -extract status raw - <<<"$result" 2>/dev/null || true)"
    if [[ -z "$id" ]]; then
        echo "package.sh: notarytool returned no submission id for $(basename "$file"): $result" >&2
        exit 1
    fi
    echo "package.sh: notarization of $(basename "$file"): $status ($id)" >&2
    # The log endpoint can lag the --wait result by a few seconds.
    for _ in 1 2 3 4 5; do
        if xcrun notarytool log "$id" "${auth[@]}" >&2; then
            break
        fi
        sleep 10
    done
    if [[ "$status" != "Accepted" ]]; then
        echo "package.sh: notarization of $(basename "$file") ended with '$status'" >&2
        exit 1
    fi
}

# Kustodian.app inside Kustodian-<version>-<rid>.zip and Kustodian-<version>-<rid>.dmg; signed with Developer ID and
# notarized when the variables above are set, ad-hoc signed otherwise.
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

    if [[ -n "$macos_sign_identity" ]]; then
        # The bundle holds one executable, so signing the bundle signs it; the hardened runtime and a secure timestamp
        # are what notarization requires.
        codesign --force --options runtime --timestamp --entitlements "$release/macos/Kustodian.entitlements" \
            --sign "$macos_sign_identity" "$app" >&2
        codesign --verify --strict --verbose=2 "$app" >&2
        codesign -dvv "$app" 2>&1 | grep -E "^(Authority=Developer ID Application|TeamIdentifier)" >&2
        # The hardened runtime is what the entitlements are for: run the signed executable once more under it.
        if [[ "$rid" == "$(host_rid)" ]]; then
            "$release/smoke.sh" "$app/Contents/MacOS/Kustodian" "$version"
        fi
    else
        # Apple Silicon refuses to run unsigned arm64 code, so the bundle gets an ad-hoc signature.
        codesign --force --deep --sign - "$app" >&2
        codesign --verify --deep --strict "$app" >&2
    fi

    rm -f "$zip" "$dmg"
    if macos_can_notarize; then
        # The service takes the app in a zip; the ticket is then stapled to the app itself, so it opens offline too.
        ditto -c -k --keepParent "$app" "$work/notarize.zip"
        notarize "$work/notarize.zip"
        rm -f "$work/notarize.zip"
        xcrun stapler staple "$app" >&2
        xcrun stapler validate "$app" >&2
    elif [[ -n "$macos_sign_identity" ]]; then
        echo "package.sh: APPLE_ID, APPLE_TEAM_ID or APPLE_APP_PASSWORD is not set; the app is signed but not notarized" >&2
    fi

    ditto -c -k --keepParent "$app" "$zip"
    echo "package.sh: wrote $zip" >&2

    ln -s /Applications "$work/stage/Applications"
    hdiutil create -volname Kustodian -srcfolder "$work/stage" -ov -format UDZO "$dmg" >&2
    if [[ -n "$macos_sign_identity" ]]; then
        codesign --force --timestamp --sign "$macos_sign_identity" "$dmg" >&2
    fi
    if macos_can_notarize; then
        notarize "$dmg"
        xcrun stapler staple "$dmg" >&2
    fi
    echo "package.sh: wrote $dmg" >&2
}

# appimagetool and the AppImage runtime it embeds, pinned to tagged releases and checked against
# tools/release/linux/appimagetool.sha256 before use. appimagetool fetches the runtime from the type2-runtime "continuous"
# release unless it is given one, so the runtime is pinned and passed with --runtime-file too.
appimagetool_url="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
appimage_runtime_url="https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"

# Downloads the pinned appimagetool and runtime into artifacts/tools/ (when missing) and checks both; stops on a mismatch.
fetch_appimagetool() {
    local tools="$artifacts/tools" url name tool
    for tool in curl sha256sum; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "package.sh: $tool is not installed" >&2
            exit 1
        fi
    done
    mkdir -p "$tools"
    for url in "$appimagetool_url" "$appimage_runtime_url"; do
        name="$(basename "$url")"
        if [[ ! -f "$tools/$name" ]]; then
            curl -fsSL --retry 3 -o "$tools/$name.part" "$url"
            mv "$tools/$name.part" "$tools/$name"
        fi
    done
    if ! (cd "$tools" && sha256sum -c --strict "$release/linux/appimagetool.sha256" >&2); then
        echo "package.sh: appimagetool or its runtime does not match tools/release/linux/appimagetool.sha256" >&2
        rm -f "$tools/appimagetool-x86_64.AppImage" "$tools/runtime-x86_64"
        exit 1
    fi
    chmod +x "$tools/appimagetool-x86_64.AppImage"
}

# Kustodian-<version>-linux-x64.tar.gz (folder Kustodian-<version>/: Kustodian, kustodian.desktop, kustodian.png, LICENSE,
# README.md) and Kustodian-<version>-x86_64.AppImage (the app only; WebKitGTK, libsecret and libnotify come from the
# distribution).
package_linux() {
    local rid="$1" publish="$2" version="$3"
    local tarball="$artifacts/Kustodian-$version-$rid.tar.gz" appimage="$artifacts/Kustodian-$version-x86_64.AppImage"
    if [[ ! -f "$publish/Kustodian" ]]; then
        echo "package.sh: $publish/Kustodian is missing after publish" >&2
        exit 1
    fi
    work="$(mktemp -d)"

    local top="$work/Kustodian-$version"
    mkdir -p "$top"
    install -m 755 "$publish/Kustodian" "$top/Kustodian"
    install -m 644 "$release/linux/kustodian.desktop" "$top/kustodian.desktop"
    install -m 644 "$root/assets/icon-256.png" "$top/kustodian.png"
    install -m 644 "$root/LICENSE" "$top/LICENSE"
    install -m 644 "$root/README.md" "$top/README.md"
    rm -f "$tarball"
    tar -C "$work" --owner=0 --group=0 --numeric-owner -czf "$tarball" "Kustodian-$version"
    echo "package.sh: wrote $tarball" >&2

    local appdir="$work/Kustodian.AppDir"
    mkdir -p "$appdir/usr/bin"
    install -m 755 "$publish/Kustodian" "$appdir/usr/bin/Kustodian"
    install -m 644 "$release/linux/kustodian.desktop" "$appdir/kustodian.desktop"
    install -m 644 "$root/assets/icon-256.png" "$appdir/kustodian.png"
    install -m 755 "$release/linux/AppRun" "$appdir/AppRun"

    fetch_appimagetool
    rm -f "$appimage"
    # APPIMAGE_EXTRACT_AND_RUN: appimagetool is itself an AppImage, and this way it runs without FUSE.
    ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$artifacts/tools/appimagetool-x86_64.AppImage" \
        --runtime-file "$artifacts/tools/runtime-x86_64" "$appdir" "$appimage" >&2
    chmod +x "$appimage"
    echo "package.sh: wrote $appimage" >&2
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
        if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
            echo "package.sh: the Linux packages are built on Linux x64 only" >&2
            exit 2
        fi
        platform=linux
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
    "$release/smoke.sh" "$exe" "$version"
fi

mkdir -p "$artifacts"
"package_$platform" "$rid" "$publish" "$version"

"$release/checksums.sh"
