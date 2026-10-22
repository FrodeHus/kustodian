# Kustodian Plan 4: Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** turn the built app into downloadable v1 builds for every platform in spec section 10. That means one self-contained
executable per runtime identifier, packaged the way each platform expects, with a README that gets people past unsigned-build
warnings and missing Linux packages.

**Architecture:**

- **Build properties.** `kustodian/Directory.Build.props` gains the version. The host project gains the single-file,
  self-contained publish properties.
- **Packaging script.** One packaging script, `kustodian/tools/release/package.sh <rid>`, publishes a runtime identifier
  and packages it:
  - Windows: a zip.
  - macOS: an `.app` bundle, ad-hoc signed, as a zip and a dmg.
  - Linux: a tarball and an AppImage.
  It writes to `kustodian/artifacts/` and adds the files to `SHA256SUMS.txt`.
- **Release workflow.** A tag-driven release workflow runs the script on the three GitHub runners. Per spec section 10, it only
  runs once `kustodian/` becomes its own repository. Until then the script runs locally, on the Windows VM, and in a Linux
  container.
- **Icon.** One SVG source. The `.ico`, `.icns` and PNG files are generated once by scripts and committed.
- **Linux check.** A startup check turns a missing WebKitGTK or libsecret into a message that names the packages.

**Tech Stack:**

- .NET 10 SDK publish (`PublishSingleFile`, `SelfContained`, `IncludeNativeLibrariesForSelfExtract`).
- bash (shellcheck-clean).
- macOS `sips`, `iconutil`, `codesign` and `hdiutil`.
- `appimagetool`, at a pinned release, verified by SHA-256.
- A .NET 10 file-based app (`dotnet run file.cs`) for the `.ico`.

**Spec:** `kustodian/docs/superpowers/specs/2026-10-21-kustodian-design.md`, sections 10 (layout and build), 13 (manual checks
before v1), 14 (risks 3 and 4) and 15 (unsigned v1).

## Global Constraints

- **Location.** Everything lives under `kustodian/`, and nothing outside it is referenced (spec 10).
- **Warnings.** Warnings are errors: `dotnet build -warnaserror`, oxlint and `tsc` must pass. Every new shell script passes
  `shellcheck` with no `disable` directives. The only open warnings are the two listed in `kustodian/CLAUDE.md`.
- **Runtime identifiers.** Exactly `win-x64`, `win-arm64`, `osx-arm64`, `osx-x64` and `linux-x64` (spec 10).
- **Self-contained.** Builds are self-contained, so no .NET install is needed, and single-file. Native libraries (Photino) are
  bundled and extracted on first run. No trimming, because MSAL, Kusto.Language and the bridge's JSON use reflection.
- **Packages:**
  - Windows: `Kustodian-<version>-win-x64.zip` and `Kustodian-<version>-win-arm64.zip`, each holding `Kustodian.exe` plus
    `LICENSE` and `README.md`.
  - macOS: `Kustodian.app` inside both `Kustodian-<version>-<rid>.zip` and `Kustodian-<version>-<rid>.dmg`, for `osx-arm64`
    and `osx-x64`.
  - Linux: `Kustodian-<version>-linux-x64.tar.gz` (the executable, `kustodian.desktop`, icon, `LICENSE`, `README.md`) and
    `Kustodian-<version>-x86_64.AppImage`.
- **Version.** v1 is `1.0.0`. `InformationalVersion` keeps the SDK's `+<commit>` suffix, and `app.info` already strips it.
- **Bundle identifier.** `io.github.frodehus.kustodian`. Display name `Kustodian`.
- **Unsigned (spec 15).** No Apple Developer ID and no Authenticode. macOS bundles get an ad-hoc signature
  (`codesign --force --deep --sign -`), because Apple Silicon refuses to run unsigned arm64 code at all.
- **Linux dependencies.** WebKitGTK 4.1 and libsecret come from the distribution and are never bundled (spec 10). The AppImage
  bundles only the app itself.
- **Downloaded tools.** Every tool a script downloads (only `appimagetool`) is pinned to a version and checked against a
  committed SHA-256 before use. It is never piped to a shell.
- **CI.** The workflow lives in `kustodian/.github/workflows/` and is inert until the split (spec 10). Nothing outside
  `kustodian/` changes.

## Review Focus

1. **The engine worker from a single-file build.** The host starts the engine as `Environment.ProcessPath --engine`
   (`GraphEngineOptions.WorkerPath`, `GraphEnginePool.CreateStartInfo`). In a single-file bundle that path is the bundle
   itself, which is correct, but each worker extracts native libraries too. A published-build smoke test must start a worker,
   run one query and kill it. Expected: the worker answers and no orphan process is left.
2. **Missing Linux libraries.** Without `libwebkit2gtk-4.1` or `libsecret-1`, Photino throws `DllNotFoundException` deep in
   startup. Expected: before Photino loads, the app writes "Kustodian needs WebKitGTK 4.1 and libsecret: install
   libwebkit2gtk-4.1-0 and libsecret-1-0 (Debian/Ubuntu) or webkit2gtk4.1 and libsecret (Fedora)." to stderr and exits with
   code 3.
3. **Read-only or odd install locations.** The app may sit in `/Applications`, in a path with spaces, or in a read-only AppImage
   mount. Expected: single-file extraction goes to the user's temp or cache folder, never next to the executable, and user data
   still goes to `AppPaths`. A smoke test runs the published build from a folder whose name has a space.
4. **The macOS keychain after updates.** An ad-hoc signature changes with every build, so macOS may ask once to allow keychain
   access after an update. Expected: the README says so, and the existing memory-only fallback still works when access is
   denied (manual check).
5. **The quarantine flag after download.** Expected: the README gives the exact steps for each platform:
   - macOS 15: System Settings → Privacy & Security → Open Anyway, or `xattr -dr com.apple.quarantine`.
   - Windows: SmartScreen "More info → Run anyway", plus unblocking the zip.
   - Linux: `chmod +x` on the AppImage, and `libfuse2` for AppImage.

   The fresh-download manual check (Task 8) runs these steps on each platform.

---

### Task 1: Version and `--version`

**Files:**
- Modify: `kustodian/Directory.Build.props`: add `<Version>1.0.0</Version>`.
- Modify: `kustodian/src/Kustodian/App/EntryPoint.cs`: add `public const string VersionFlag = "--version";`.
- Modify: `kustodian/src/Kustodian/Program.cs`.
- Test: `kustodian/tests/Kustodian.Tests/App/EntryPointTests.cs` (create it, or extend the file that tests `Dispatch`).

**Interfaces:**
- Produces: `EntryPoint.Dispatch(string[] args, Func<int> runEngine, Func<int> openWindow, Func<int> printVersion)`.
  With `args[0] == "--version"` it calls `printVersion` only. `Program` passes a function that writes
  `Kustodian <InformationalVersion without +commit>` to stdout and returns 0.
- Produces: an `AppVersion.Text` static (`kustodian/src/Kustodian/App/AppVersion.cs`). It holds the version-trimming logic
  that today sits in `AppHandler.Version()`, so `AppHandler` and `--version` share it.

- [ ] **Step 1: Write the failing tests:**
  - `Dispatch_with_version_flag_prints_version_only`: neither the engine nor the window delegate runs, and the return value is
    `printVersion`'s.
  - `App_version_strips_commit_suffix`: `AppVersion.Trim("1.0.0+abc123") == "1.0.0"`.
- [ ] **Step 2:** Run `dotnet test --project kustodian/tests/Kustodian.Tests`. Expected: compile failure on the new signature.
- [ ] **Step 3:** Implement. `AppHandler` uses `AppVersion.Text`.
- [ ] **Step 4:** Run the tests. Expected: they pass.
- [ ] **Step 5:** Commit: `feat(kustodian): version 1.0.0 and --version`.

### Task 2: Single-file publish, the Linux library check, and a published-build smoke test

**Files:**
- Modify: `kustodian/src/Kustodian/Kustodian.csproj`. Add the following, active only when `RuntimeIdentifier` is set, so
  `dotnet build` and `dotnet test` are unchanged:
  - `SelfContained=true`, `PublishSingleFile=true`, `IncludeNativeLibrariesForSelfExtract=true`;
  - `EnableCompressionInSingleFile=true`, `DebugType=embedded`, `PublishTrimmed=false`;
  - `AssemblyName=Kustodian`.
- Create: `kustodian/src/Kustodian/App/NativeCheck.cs`.
- Modify: `kustodian/src/Kustodian/Program.cs`. Call the check on the window path only. It runs before `AppHost.Run`, and
  never on `--engine` or `--version`.
- Create: `kustodian/tools/release/publish.sh`.
- Create: `kustodian/tools/release/smoke.sh`.
- Test: `kustodian/tests/Kustodian.Tests/App/NativeCheckTests.cs`.

**Interfaces:**
- Produces: `NativeCheck.Missing(Func<string, bool> canLoad) : IReadOnlyList<string>`. On Linux it tries
  `libwebkit2gtk-4.1.so.0` and `libsecret-1.so.0` through `NativeLibrary.TryLoad`. On other platforms it returns empty. It
  also produces `NativeCheck.Message(IReadOnlyList<string> missing) : string`, which returns the exact text in Review Focus 2.
  Exit code 3.
- Produces: `publish.sh <rid> [outdir]`. It runs `dotnet publish kustodian/src/Kustodian/Kustodian.csproj -c Release -r <rid>`
  and writes to `kustodian/artifacts/publish/<rid>/`. It prints the output path, and refuses unknown runtime identifiers with
  exit code 2.
- Produces: `smoke.sh <published-executable>`, which:
  1. copies the executable into a temp folder named `Kustodian smoke` (with a space);
  2. runs `--version` and checks the output matches `^Kustodian 1\.0\.0$`;
  3. runs `--engine`, sends one engine protocol request that evaluates `print x=1` (use the request shape from
     `Kustodian.Engine` tests), checks the answer, closes stdin, and checks the process exits within 5 s;
  4. exits non-zero on any failure.

- [ ] **Step 1: Write the failing tests:**
  - `Missing_lists_each_library_that_does_not_load`;
  - `Missing_is_empty_when_all_load`;
  - `Message_names_debian_and_fedora_packages`. Assert the exact text.
- [ ] **Step 2:** Run them. Expected: they fail.
- [ ] **Step 3:** Implement `NativeCheck` and wire it into `Program`.
- [ ] **Step 4:** Run them. Expected: they pass.
- [ ] **Step 5:** Write the two scripts, then run `shellcheck kustodian/tools/release/*.sh`. Expected: no output.
- [ ] **Step 6:** Run `kustodian/tools/release/publish.sh osx-arm64` on macOS, then `smoke.sh` on the result. Expected: both
  pass, and the executable is a single file plus nothing else needed. Run the same pair for `linux-x64` in the Ubuntu
  container. Also run the container once without `libwebkit2gtk-4.1-0` and check that stderr carries the message and the exit
  code is 3.
- [ ] **Step 7:** Commit: `build(kustodian): single-file self-contained publish and a published-build smoke test`.

### Task 3: App icon

**Files:**
- Create: `kustodian/assets/icon.svg`. A simple, original mark: the letter K inside a rounded square in the app's accent
  colour, legible at 16 px. No third-party artwork.
- Create: `kustodian/tools/release/make-icons.sh`, run on macOS. It renders `icon.svg` to a 1024 px PNG with `sips` (via
  `qlmanage` if `sips` can't read SVG), then builds:
  - `kustodian/assets/icon.icns` with `iconutil`, from an `.iconset` of 16 to 1024 px;
  - `kustodian/assets/icon-256.png` and `icon-512.png` for Linux.
- Create: `kustodian/tools/release/make-ico.cs`, a .NET 10 file-based app. It writes `kustodian/assets/icon.ico` with
  PNG-compressed entries at 16, 32, 48 and 256 px from the rendered PNGs.
- Commit the generated files under `kustodian/assets/`.
- Modify: `kustodian/src/Kustodian/Kustodian.csproj`: `ApplicationIcon=..\..\assets\icon.ico` (Windows exe icon). Embed
  `icon-256.png` as `icon.png`.
- Modify: `kustodian/src/Kustodian/App/AppWindow.cs`. Set the window icon on Windows and Linux from the embedded PNG,
  written once to the app's cache folder (Photino's `SetIconFile` takes a path). macOS takes the icon from the bundle.

- [ ] **Step 1:** Draw the SVG and run the scripts. Expected: the four asset files exist. `file icon.ico` reports an MS Windows
  icon resource with 4 icons.
- [ ] **Step 2:** Run `shellcheck` on the script and `dotnet build kustodian/Kustodian.slnx -warnaserror`. Expected: clean.
- [ ] **Step 3:** Commit: `feat(kustodian): app icon`.

### Task 4: Windows zip

**Files:**
- Create: `kustodian/tools/release/package.sh`, the single entry point: `package.sh <rid>`. It calls `publish.sh`, then
  `smoke.sh` when the runtime identifier matches the build machine, then the platform's packaging function, then
  `checksums.sh`.
- Create: `kustodian/tools/release/checksums.sh`, which rewrites `kustodian/artifacts/SHA256SUMS.txt` from every package in
  `kustodian/artifacts/`. It uses `sha256sum` or `shasum -a 256`, whichever exists.

**Interfaces:**
- Produces: `package_windows <rid>`, which zips `Kustodian.exe`, `LICENSE` and `README.md` into
  `kustodian/artifacts/Kustodian-<version>-<rid>.zip`. The version comes from
  `dotnet msbuild kustodian/src/Kustodian/Kustodian.csproj -getProperty:Version`. Both Windows runtime identifiers build on
  any OS.

- [ ] **Step 1:** Implement. Run `package.sh win-x64` and `package.sh win-arm64` on macOS. Expected: both zips and
  `SHA256SUMS.txt`, and `unzip -l` lists exactly the three files.
- [ ] **Step 2:** Copy `win-arm64` to the Windows 11 ARM VM, using the `windows-vm` skill. Unzip it, run `Kustodian.exe
  --version`, then open the window and capture it. Expected: version 1.0.0, and the window shows the sign-in screen with the
  icon in the title bar and taskbar.
- [ ] **Step 3:** Run `shellcheck`. Expected: clean.
- [ ] **Step 4:** Commit: `build(kustodian): Windows zip packages`.

### Task 5: macOS `.app`, zip and dmg

**Files:**
- Create: `kustodian/tools/release/macos/Info.plist.in`, with placeholders `@VERSION@` and `@MINOS@`. Keys:
  - `CFBundleName`, `CFBundleDisplayName` `Kustodian`, `CFBundleIdentifier` `io.github.frodehus.kustodian`;
  - `CFBundleExecutable` `Kustodian`, `CFBundleIconFile` `icon`, `CFBundlePackageType` `APPL`;
  - `CFBundleShortVersionString` and `CFBundleVersion` set to the version;
  - `LSMinimumSystemVersion` set to .NET 10's minimum macOS version, checked on Microsoft Learn's .NET 10 supported OS list;
  - `NSHighResolutionCapable` `true`.
- Modify: `package.sh`, adding `package_macos <rid>`.

**Interfaces:**
- Produces: `package_macos <rid>`. It runs on macOS only and otherwise refuses with exit code 2.
  1. Build `Kustodian.app/Contents/{MacOS/Kustodian, Resources/icon.icns, Info.plist}`.
  2. `chmod +x` the executable.
  3. Run `codesign --force --deep --sign - Kustodian.app`, then `codesign --verify --deep --strict`.
  4. Zip it with `ditto -c -k --keepParent` into `Kustodian-<version>-<rid>.zip`.
  5. Build a dmg with `hdiutil create -volname Kustodian -srcfolder <staging> -ov -format UDZO`. The staging folder holds
     the `.app` and a symlink to `/Applications`.

- [ ] **Step 1:** Implement. Run `package.sh osx-arm64` and `package.sh osx-x64` on macOS. Expected: two zips and two dmgs, and
  `codesign --verify` passes for both bundles.
- [ ] **Step 2:** Open the arm64 `.app` from the mounted dmg. Expected: the window opens with the Dock icon, and
  `Kustodian.app/Contents/MacOS/Kustodian --version` prints 1.0.0. Run `smoke.sh` against the bundle's executable.
- [ ] **Step 3:** Run `shellcheck`. Expected: clean.
- [ ] **Step 4:** Commit: `build(kustodian): macOS app bundle, zip and dmg`.

### Task 6: Linux tarball and AppImage

**Files:**
- Create: `kustodian/tools/release/linux/kustodian.desktop` with:
  - `Name=Kustodian`, `Exec=Kustodian`, `Icon=kustodian`, `Type=Application`;
  - `Categories=Development;Utility;`;
  - `Comment=Write and run KQL against Microsoft Graph, Defender and Azure Resource Graph`.
- Create: `kustodian/tools/release/linux/AppRun`. It `exec`s `"$APPDIR/usr/bin/Kustodian" "$@"`.
- Create: `kustodian/tools/release/linux/appimagetool.sha256`, holding the pinned release's checksum.
- Modify: `package.sh`, adding `package_linux linux-x64`.

**Interfaces:**
- Produces: `package_linux`. It runs on Linux x64 only and otherwise refuses with exit code 2.
  - **Tarball** `Kustodian-<version>-linux-x64.tar.gz`, with the top folder `Kustodian-<version>/` holding `Kustodian`,
    `kustodian.desktop`, `kustodian.png` (256 px), `LICENSE` and `README.md`.
  - **AppImage:**
    1. Build an AppDir: `usr/bin/Kustodian`, `kustodian.desktop`, `kustodian.png`, `AppRun`.
    2. Download `appimagetool-x86_64.AppImage` from its pinned release URL to `kustodian/artifacts/tools/`, check it against
       `appimagetool.sha256`, and stop on a mismatch.
    3. Run it with `APPIMAGE_EXTRACT_AND_RUN=1`, so FUSE isn't needed on the build machine. Output:
       `Kustodian-<version>-x86_64.AppImage`.

- [ ] **Step 1:** Implement. In the Ubuntu 24.04 container (amd64; on Apple Silicon use `--platform linux/amd64`), install
  `libwebkit2gtk-4.1-dev libsecret-1-dev` and the .NET SDK, then run `package.sh linux-x64`. Expected: the tarball and the
  AppImage, and their checksums in `SHA256SUMS.txt`.
- [ ] **Step 2:** In the container, run `smoke.sh` on the tarball's executable. Then run `./Kustodian-*.AppImage --version`
  with `APPIMAGE_EXTRACT_AND_RUN=1`. Expected: `Kustodian 1.0.0`.
- [ ] **Step 3:** In a Fedora container, do the same with the tarball after `dnf install webkit2gtk4.1 libsecret` (spec risk
  3). Expected: `--version` passes and `smoke.sh` passes. The window can't open in a headless container; the owner opens it
  in Task 8.
- [ ] **Step 4:** Run `shellcheck`. Expected: clean.
- [ ] **Step 5:** Commit: `build(kustodian): Linux tarball and AppImage`.

### Task 7: Release workflow and README

**Files:**
- Create: `kustodian/.github/workflows/release.yml`. It triggers on tags `v*` and on `workflow_dispatch`, with
  `permissions: contents: write`. Matrix:

  | Runner | Runtime identifiers |
  | --- | --- |
  | `windows-latest` (bash) | `win-x64`, `win-arm64` |
  | `macos-latest` | `osx-arm64`, `osx-x64` |
  | `ubuntu-latest` | `linux-x64` |

  Each job installs the .NET SDK from `global.json`, Node 22 and, on Linux, the WebKitGTK/libsecret dev packages. It runs
  `tools/release/package.sh <rid>` and uploads `artifacts/*`. A final job merges the artifacts, rebuilds `SHA256SUMS.txt`, and
  creates a draft GitHub release with every file. Pin each action to the major version that `ci.yml` uses.
- Modify: `kustodian/README.md`. Sections, in this order:
  1. **What it is.** One paragraph: Graph, Defender hunting and Resource Graph.
  2. **Download.** Which file for which platform.
  3. **First run on macOS (unsigned).**
     - Open the dmg and drag the app to Applications.
     - The first open is blocked: go to System Settings → Privacy & Security → Open Anyway, or run
       `xattr -dr com.apple.quarantine /Applications/Kustodian.app`.
     - macOS may ask once to allow keychain access after each update.
  4. **First run on Windows (unsigned).**
     - Before extracting, right-click the zip → Properties → Unblock.
     - SmartScreen: More info → Run anyway.
     - WebView2 is built into Windows 11. On Windows 10 without it, install the Evergreen WebView2 Runtime (link to
       Microsoft's page).
  5. **Linux.**
     - Packages: `libwebkit2gtk-4.1-0` and `libsecret-1-0` on Debian/Ubuntu; `webkit2gtk4.1` and `libsecret` on Fedora.
     - The AppImage needs FUSE 2 (`libfuse2` / `fuse-libs`), plus `chmod +x`.
     - Tarball: extract it and run `./Kustodian`. Optionally copy the `.desktop` file and icon into place.
  6. **Signing in.** The Azure CLI client by default, or your own app registration, with "Create Entra ID application"
     (PR #204).
  7. **Where data lives.** Use the `AppPaths` folders per platform, read from the code.
  8. **Verifying downloads.** `shasum -a 256 -c SHA256SUMS.txt`.
  9. **Building from source.** The existing build commands, plus `tools/release/package.sh <rid>`.
- Modify: `kustodian/.gitignore`: add `artifacts/`.

- [ ] **Step 1:** Write the workflow and the README.
- [ ] **Step 2:** Validate the workflow with `actionlint` if it's available locally. Otherwise check the YAML parses and that
  every `run:` script is shellcheck-clean, by extracting each one to a file. Expected: clean.
- [ ] **Step 3:** Run `dotnet build kustodian/Kustodian.slnx -warnaserror` and the web gate. Expected: unchanged.
- [ ] **Step 4:** Commit: `build(kustodian): release workflow and install guide`.

### Task 8: Fresh-download manual checks

**Files:**
- Modify: `kustodian/docs/manual-checks.md`. Add a "Plan 4: release builds (date)" section with one column per platform
  (macOS arm64, macOS x64 if hardware is available, Windows x64/arm64, Ubuntu, Fedora). Rows:
  - The package downloads and its checksum matches `SHA256SUMS.txt`.
  - The first open follows the README's unsigned-build steps exactly.
  - The window opens with its icon, and the title shows the version.
  - Sign-in, and the keychain prompt (macOS) or libsecret (Linux).
  - A Graph query runs: the engine worker starts from the single-file build, and no orphan process is left after quitting.
  - The app runs from a folder with a space in its name.
  - A missing WebKitGTK gives the named-package message (Linux).
  - The AppImage needs `libfuse2`, and the README's step fixes it.
  - Spec 13's list: cancel during a long run; killing the engine by memory; restarting with unsaved tabs; a missing keychain
    on Linux.

- [ ] **Step 1:** Run the full gate on macOS, in the Linux container and on the Windows VM. Build every package that each
  machine can build (Tasks 4–6).
- [ ] **Step 2:** Do the rows the builder can do without a tenant. Copy each package as a "download" by setting the
  quarantine attribute on macOS and the Mark-of-the-Web on Windows, then follow the README. Capture only Kustodian's window.
  Every row that needs a tenant or real hardware stays "owner".
- [ ] **Step 3:** Commit: `docs(kustodian): manual checks for release builds`.
