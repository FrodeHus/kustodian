<#
.SYNOPSIS
  Publishes Kustodian for Windows and builds the MSI for each architecture.

.DESCRIPTION
  For every architecture: publishes the single-file, self-contained Kustodian.exe (the same properties as
  tools/release/publish.sh), checks its --version where the host can run it, then `wix build` of Kustodian.wxs into
  Kustodian-<version>-<arch>.msi, validated with `wix msi validate`, with a .sha256 beside it. The MSI installs per user by
  default or per machine with ALLUSERS=1. Both files are copied to artifacts\ at the repository root. Signs Kustodian.exe
  and the MSI with signtool and the Certum code-signing certificate when -Sign is given.

  Needs the .NET 10 SDK (and Node.js for the web UI, built by the project when web\dist is missing or stale) and WiX 5.0.2:
  `dotnet tool install --global wix --version 5.0.2`.

.PARAMETER Version
  The product version, e.g. 1.0.0. Also stamped into the assembly.

.PARAMETER Architectures
  x64, arm64, or both (the default).

.PARAMETER Sign
  Sign Kustodian.exe and the MSIs with signtool, using the certificate whose SHA-1 thumbprint is in CERTUM_KEY_ID. The
  certificate must be in the current user's store with its private key reachable: a Certum SimplySign session, or any
  other CSP-backed certificate. Timestamped by Certum's RFC 3161 server.
#>
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [ValidateSet("x64", "arm64")]
    [string[]]$Architectures = @("x64", "arm64"),
    [switch]$Sign
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# WiX v5: v6 and later require accepting the Open Source Maintenance Fee EULA, a decision for the maintainers.
$WixVersion = "5.0.2"
$installer = $PSScriptRoot
$root = (Resolve-Path (Join-Path $installer "..\..\..")).Path
$project = Join-Path $root "src\Kustodian\Kustodian.csproj"
$artifacts = Join-Path $root "artifacts"
$out = Join-Path $artifacts "msi"

$installWix = "dotnet tool install --global wix --version $WixVersion"
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    throw "The WiX toolset is not installed: run ``$installWix``."
}
$wixReported = (wix --version | Out-String).Trim()
if ($wixReported -ne $WixVersion -and -not $wixReported.StartsWith("$WixVersion+")) {
    throw "WiX $WixVersion is needed, found '$wixReported': run ``dotnet tool uninstall --global wix`` and ``$installWix``."
}
# The UI extension provides the dialogs and the exit dialog's launch checkbox; its version must match the tool's.
wix extension add --global "WixToolset.UI.wixext/$WixVersion" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "wix extension add WixToolset.UI.wixext/$WixVersion failed" }
New-Item -ItemType Directory -Force -Path $out | Out-Null

function Invoke-Signing([string]$Path) {
    Write-Host "== Signing $Path"
    if (-not $env:CERTUM_KEY_ID) { throw "CERTUM_KEY_ID (the signing certificate's SHA-1 thumbprint) is not set." }
    signtool sign /v /fd SHA256 /sha1 $env:CERTUM_KEY_ID /tr http://time.certum.pl /td SHA256 $Path
    if ($LASTEXITCODE -ne 0) { throw "signtool failed for $Path" }
    signtool verify /pa /v $Path
    if ($LASTEXITCODE -ne 0) { throw "signtool verify failed for $Path" }
}

foreach ($arch in $Architectures) {
    $rid = "win-$arch"
    $publishDir = Join-Path $artifacts "publish\$rid"
    if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }

    # 1. The single-file, self-contained publish (the project sets those properties whenever a runtime identifier is given).
    Write-Host "== Publishing $rid"
    dotnet publish $project -c Release -r $rid "-p:Version=$Version" -o $publishDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed for $rid" }
    $exe = Join-Path $publishDir "Kustodian.exe"
    if (-not (Test-Path $exe)) { throw "Kustodian.exe missing after publish ($rid)" }

    # 2. --version, where the host runs the build: natively on an x64 host (x64), or on an Arm host (x64 under emulation,
    # arm64 native). Kustodian.exe is a GUI (WinExe) build; piping its output redirects stdout, which it writes to, and makes
    # PowerShell wait for it to exit.
    if ($arch -eq "x64" -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
        $reported = (& $exe --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Kustodian.exe --version exited with $LASTEXITCODE ($rid)" }
        if ($reported -ne "Kustodian $Version") {
            throw "Kustodian.exe --version printed '$reported', expected 'Kustodian $Version' ($rid)"
        }
        Write-Host "== --version: $reported"
    }

    # 3. The MSI's signature covers the package, not the file it installs: sign the executable too, so the installed
    # Kustodian.exe carries the publisher.
    if ($Sign) { Invoke-Signing $exe }

    # 4. The package.
    $msi = Join-Path $out "Kustodian-$Version-$arch.msi"
    Write-Host "== Building $msi"
    wix build (Join-Path $installer "Kustodian.wxs") -arch $arch -d "Version=$Version" -d "PublishDir=$publishDir" `
        -ext WixToolset.UI.wixext -b $installer -o $msi
    if ($LASTEXITCODE -ne 0) { throw "wix build failed for $arch" }

    # 5. The package is dual-purpose (per user or per machine), which holds only while nothing in it names a per-user or a
    # per-machine location outright; ICE105 and its neighbours check that.
    wix msi validate $msi
    if ($LASTEXITCODE -ne 0) { throw "wix msi validate failed for $arch" }

    # 6.
    if ($Sign) { Invoke-Signing $msi }

    # 7. The checksum, then both files into artifacts\.
    $hash = (Get-FileHash -Algorithm SHA256 $msi).Hash.ToLowerInvariant()
    "$hash *$(Split-Path -Leaf $msi)" | Set-Content -Path "$msi.sha256" -Encoding ascii
    Copy-Item -Force $msi, "$msi.sha256" -Destination $artifacts
    Write-Host "== $(Join-Path $artifacts (Split-Path -Leaf $msi)) sha256 $hash"
}
