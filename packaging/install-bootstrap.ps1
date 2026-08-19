# wxnodus install-bootstrap (checked-in, NOT generated): three-source download entry.
# Source A (default): zip already at hand (-Zip path) -> extract and delegate.
# Source B: -Url https://... (https enforced; user-run script, URL is the user's own input)
# Source C: -GitHub owner/repo [-Tag v3.1.0] -> gh release download (gh auth status gate;
#           no token written to disk, no token embedded).
# DX convention: pure ASCII body (PS 5.1 parses ANSI without BOM); delegates to the
# generated install.ps1 inside the zip for the actual install (sha256-verified, journaled).
param(
  [string]$Zip = '',
  [string]$Url = '',
  [string]$GitHub = '',
  [string]$Tag = 'latest',
  [string]$TargetDir = (Join-Path "$env:LOCALAPPDATA\Programs" 'wxnodus'),
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ('wxnodus-bootstrap-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  $ZipPath = $Zip
  if ($Zip -and -not (Test-Path $Zip)) { Write-Error "BOOTSTRAP_ZIP_NOT_FOUND: $Zip"; exit 1 }
  if ($Url) {
    if (-not $Url.StartsWith('https://')) { Write-Error "BOOTSTRAP_URL_NOT_HTTPS: only https sources are accepted"; exit 1 }
    $ZipPath = Join-Path $Temp 'wxnodus.zip'
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
  }
  if ($GitHub) {
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Error "BOOTSTRAP_GH_AUTH_REQUIRED: run 'gh auth login' first (install gh: winget install GitHub.cli) - private release download needs auth"
      exit 1
    }
    & gh release download $Tag --repo $GitHub --pattern '*.zip' --dir $Temp
    $Downloaded = Get-ChildItem $Temp -Filter '*.zip' | Select-Object -First 1
    if (-not $Downloaded) { Write-Error "BOOTSTRAP_GH_NO_ASSET: no zip asset found (-Tag $Tag -GitHub $GitHub)"; exit 1 }
    $ZipPath = $Downloaded.FullName
  }
  if (-not $ZipPath) {
    Write-Error 'BOOTSTRAP_NO_SOURCE: provide -Zip <path> or -Url <https URL> or -GitHub <owner/repo>'
    exit 1
  }
  $Unpack = Join-Path $Temp 'unpacked'
  New-Item -ItemType Directory -Force -Path $Unpack | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $Unpack -Force
  $Inner = Get-ChildItem $Unpack -Recurse -Filter 'install.ps1' | Select-Object -First 1
  if (-not $Inner) { Write-Error 'BOOTSTRAP_NO_INSTALLER: no install.ps1 inside the zip (not a wxnodus package)'; exit 1 }
  $Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Inner.FullName)
  if ($TargetDir) { $Args += @('-TargetDir', $TargetDir) }
  if ($DryRun) { $Args += '-DryRun' }
  if ($Url) { $Args += @('-Source', $Url) }
  & powershell.exe @Args
  exit $LASTEXITCODE
} finally {
  Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
