# Installing Kustodian

Kustodian is a desktop KQL workbench for your Microsoft tenant: one query language, with completion and results side by
side, against **Microsoft Graph**, **Defender advanced hunting** and **Azure Resource Graph**. It runs on Windows, macOS and
Linux.

## Download

Every release is on the [releases page](https://github.com/FrodeHus/kustodian/releases/latest). The builds are
self-contained, so you don't need to install .NET.

| Platform | File |
| --- | --- |
| Windows 11, x64 | `Kustodian-<version>-x64.msi` (recommended) or the portable `Kustodian-<version>-win-x64.zip` |
| Windows 11, Arm | `Kustodian-<version>-arm64.msi` (recommended) or the portable `Kustodian-<version>-win-arm64.zip` |
| macOS 14 or later, Apple silicon | `Kustodian-<version>-osx-arm64.dmg`, or the same app in `Kustodian-<version>-osx-arm64.zip` |
| macOS 14 or later, Intel | `Kustodian-<version>-osx-x64.dmg`, or the same app in `Kustodian-<version>-osx-x64.zip` |
| Linux x64 | `Kustodian-<version>-x86_64.AppImage` or `Kustodian-<version>-linux-x64.tar.gz` |

`SHA256SUMS.txt` lists the checksum of every package; see [Verifying downloads](#verifying-downloads).

## macOS

Open the dmg and drag **Kustodian** to **Applications**. (From the zip: unzip it and move `Kustodian.app` to
Applications.) The app is signed with an Apple Developer ID and notarized, so it opens without a prompt. Kustodian keeps
your sign-in in the macOS keychain.

### An ad-hoc signed build

The release notes say when a release's macOS app isn't notarized and carries an ad-hoc signature only. Then:

1. The first open is blocked. Go to **System Settings → Privacy & Security**, find the message about Kustodian and choose
   **Open Anyway**, then confirm. Or remove the quarantine flag in Terminal:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Kustodian.app
   ```

2. After each update, macOS may ask once whether Kustodian can use its keychain item; choose **Always Allow**.

## Windows

Windows 11 on x64 or Arm. Nothing else is needed: WebView2 is part of Windows 11.

- **MSI (recommended).** Run `Kustodian-<version>-x64.msi` (or `-arm64.msi` on Arm). It installs for you alone, with no
  admin rights, into `%LOCALAPPDATA%\Programs\Kustodian`, and adds Kustodian to the Start menu. To install for every user of
  the PC (into `%ProgramFiles%\Kustodian`, which needs admin rights):

  ```powershell
  msiexec /i Kustodian-<version>-x64.msi ALLUSERS=1
  ```

  A newer MSI installs over the old version. Uninstall from **Settings → Apps → Installed apps**.
- **Portable zip.** Before extracting, right-click the zip, choose **Properties**, tick **Unblock** and choose **OK**. Then
  extract it anywhere and run `Kustodian.exe`.
- **Unsigned builds.** A release that isn't code-signed (the release notes say so) makes SmartScreen show "Windows protected
  your PC". Choose **More info**, then **Run anyway**.

## Linux

Linux x64. Kustodian uses WebKitGTK 4.1, libsecret and libnotify from your distribution:

| Distribution | Packages |
| --- | --- |
| Debian, Ubuntu | `sudo apt install libwebkit2gtk-4.1-0 libsecret-1-0 libnotify4` |
| Fedora | `sudo dnf install webkit2gtk4.1 libsecret libnotify` |

When one is missing, Kustodian says which and exits.

- **AppImage.** It runs without FUSE (it extracts itself); with fuse3's `fusermount`, which WebKitGTK usually brings, it
  mounts instead. Make it executable and run it:

  ```sh
  chmod +x Kustodian-<version>-x86_64.AppImage
  ./Kustodian-<version>-x86_64.AppImage
  ```

- **Tarball.** Extract it and run `./Kustodian`:

  ```sh
  tar -xzf Kustodian-<version>-linux-x64.tar.gz
  cd Kustodian-<version>
  ./Kustodian
  ```

  To add it to your applications menu, put the executable on your `PATH` and copy the desktop file and icon into place:

  ```sh
  install -Dm755 Kustodian ~/.local/bin/Kustodian
  install -Dm644 kustodian.desktop ~/.local/share/applications/kustodian.desktop
  install -Dm644 kustodian.png ~/.local/share/icons/hicolor/256x256/apps/kustodian.png
  ```

Your sign-in is kept in the Secret Service keyring (GNOME Keyring, KWallet), through libsecret. Without a running keyring,
Kustodian still works, but you sign in again each time you start it.

## Signing in

Sign in with your work account. You pick the client under **Signing in as**:

- **Azure CLI** (the default): Microsoft's public Azure CLI client, with delegated permissions. It covers common Graph and Azure
  Resource Graph queries.
- **Microsoft Graph Command Line Tools**: Microsoft's public client used by Graph PowerShell. It reaches what your tenant has
  granted Graph PowerShell. Azure queries use your Azure CLI sign-in.
- **Your own app**: your own Entra ID app registration, or one Kustodian creates with **Create Entra ID application**.

Security data, audit logs and advanced hunting often need more than the Azure CLI client has.
[Entra ID permissions](EntraPermissions.md) explains each, step by step.

## Where data lives

Settings, accounts, saved queries, snippets, history and open tabs are local JSON files:

| Platform | Data | Cache (rebuilt when needed) |
| --- | --- | --- |
| Windows | `%APPDATA%\Kustodian` | `%LOCALAPPDATA%\Kustodian\Cache` |
| macOS | `~/Library/Application Support/Kustodian` | `~/Library/Caches/Kustodian` |
| Linux | `$XDG_CONFIG_HOME/kustodian`, else `~/.config/kustodian` | `$XDG_CACHE_HOME/kustodian`, else `~/.cache/kustodian` |

Tokens are never written in plain text: they're in the OS store (DPAPI-encrypted on Windows, the Keychain on macOS,
libsecret on Linux), or in memory only when no store is available. Uninstalling leaves these folders; delete them to remove
everything.

## Verifying downloads

Download `SHA256SUMS.txt` into the folder with the packages and check them:

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS.txt     # macOS
sha256sum -c --ignore-missing SHA256SUMS.txt         # Linux
```

Each package you downloaded should print `OK`. On Windows, compare `(Get-FileHash .\Kustodian-<version>-x64.msi).Hash`
with its line in `SHA256SUMS.txt` (or with the `.msi.sha256` file beside the MSI).

## Building from source

The build and test commands are in the [README](../README.md#building-from-source). To make the release packages for one
runtime identifier (`win-x64`, `win-arm64`, `osx-arm64`, `osx-x64` or `linux-x64`):

```sh
tools/release/package.sh <rid>
```

It writes the packages and `SHA256SUMS.txt` into `artifacts/`. The macOS packages build on macOS only, and the Linux ones on
Linux x64; the Windows zips build anywhere. The MSIs build on Windows with PowerShell 7 and
[WiX 5.0.2](https://wixtoolset.org/) (`dotnet tool install --global wix --version 5.0.2`):

```powershell
./tools/release/windows/build.ps1 -Version 1.0.0
```
