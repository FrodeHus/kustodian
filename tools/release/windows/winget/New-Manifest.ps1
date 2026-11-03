<#
.SYNOPSIS
  Writes the winget manifest for one release of Reothor.Kustodian from the MSIs' SHA-256 hashes.

.DESCRIPTION
  Fills the three templates next to this script (version, installer, locale) and writes them to OutDir. The installer URLs
  point at the GitHub release for tag v<version>, so the release must be published, not a draft, before winget-pkgs can
  download them. Validate the result with `winget validate --manifest <OutDir>`. Ported from Elevate
  (github.com/FrodeHus/elevate, windows/winget/New-Manifest.ps1).

.PARAMETER Version
  The release version, e.g. 1.0.0.

.PARAMETER X64Sha256
  SHA-256 of Kustodian-<version>-x64.msi.

.PARAMETER Arm64Sha256
  SHA-256 of Kustodian-<version>-arm64.msi.

.PARAMETER Repository
  owner/name of the GitHub repository the release lives in.

.PARAMETER OutDir
  Where the three manifest files go (default artifacts\winget at the repository root). Emptied first.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Version,
    [Parameter(Mandatory)] [string]$X64Sha256,
    [Parameter(Mandatory)] [string]$Arm64Sha256,
    [string]$Repository = "FrodeHus/kustodian",
    [string]$ReleaseDate = (Get-Date -Format "yyyy-MM-dd"),
    [string]$OutDir = (Join-Path $PSScriptRoot "..\..\..\..\artifacts\winget")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$values = @{
    VERSION      = $Version
    RELEASE_DATE = $ReleaseDate
    X64_URL      = "https://github.com/$Repository/releases/download/v$Version/Kustodian-$Version-x64.msi"
    ARM64_URL    = "https://github.com/$Repository/releases/download/v$Version/Kustodian-$Version-arm64.msi"
    X64_SHA256   = $X64Sha256.ToUpperInvariant()
    ARM64_SHA256 = $Arm64Sha256.ToUpperInvariant()
}

foreach ($name in "Reothor.Kustodian.yaml", "Reothor.Kustodian.installer.yaml", "Reothor.Kustodian.locale.en-US.yaml") {
    $text = Get-Content -Raw (Join-Path $PSScriptRoot "templates\$name")
    foreach ($pair in $values.GetEnumerator()) {
        $text = $text.Replace("{{" + $pair.Key + "}}", $pair.Value)
    }
    if ($text -match "\{\{\w+\}\}") { throw "$name still has a placeholder: $($Matches[0])" }
    Set-Content -Path (Join-Path $OutDir $name) -Value $text -Encoding utf8 -NoNewline
}

Write-Host "Manifest written to $(Resolve-Path $OutDir)"
