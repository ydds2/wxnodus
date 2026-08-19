# wxnodus one-line installer (Kimi Code mechanism reference: no param block, env-var config,
# TLS 1.2 fallback, fixed base + latest resolution - our own implementation, no copied text).
#
#   Public channel (after repo goes public or dist repo is provisioned):
#     irm https://raw.githubusercontent.com/ydds2/wxnodus/master/packaging/install.ps1 | iex
#   Private repo (authorized members, gh CLI authenticated):
#     gh api repos/ydds2/wxnodus/contents/packaging/install.ps1 -H "Accept: application/vnd.github.raw" | iex
#
# Optional env:
#   WXNODUS_VERSION        Explicit version; default 'latest' (resolved via GitHub API, falls back to gh CLI)
#   WXNODUS_BASE_URL       Override download base (e.g. a local mirror); zip fetched from <base>/wxnodus-<version>.zip
#   WXNODUS_INSTALL_DIR    Default %LOCALAPPDATA%\Programs\wxnodus
#   WXNODUS_NO_PATH        Non-empty skips PATH registration (delegated install.ps1 -SkipPath)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'ydds2/wxnodus'
$Version    = $env:WXNODUS_VERSION
$BaseUrl    = $env:WXNODUS_BASE_URL
$InstallDir = if ($env:WXNODUS_INSTALL_DIR) { $env:WXNODUS_INSTALL_DIR } else { Join-Path "$env:LOCALAPPDATA\Programs" 'wxnodus' }
$NoPath     = $env:WXNODUS_NO_PATH

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Die($msg)        { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

Write-Step "wxnodus one-line installer"
if (-not $Version) { $Version = 'latest' }
if ($Version -eq 'latest') {
  # Public path first (GitHub API needs no auth for public repos); gh CLI fallback for private repos.
  try {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 10 -UseBasicParsing
    $Version = $Release.tag_name
  } catch {
    try {
      $RawList = & gh release list --repo $Repo --limit 1 2>$null | Out-String
      if ($LASTEXITCODE -eq 0 -and $RawList.Trim()) {
        $Version = ($RawList.Trim() -split "`n")[0] -split "`t| " | Select-Object -First 1
      }
    } catch { }
    if (-not $Version -or $Version -eq 'latest') {
      Die "cannot resolve latest version: repo is private and gh is not authenticated. Run 'gh auth login' then retry, or set `$env:WXNODUS_VERSION"
    }
  }
}
Write-Step "resolved version: $Version"

$ZipName = "wxnodus-$($Version -replace '^v', '').zip"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ('wxnodus-one-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  $ZipPath = Join-Path $Temp $ZipName
  if ($BaseUrl) {
    Write-Step "downloading $ZipName from $BaseUrl"
    Invoke-WebRequest -Uri "$BaseUrl/$ZipName" -OutFile $ZipPath -UseBasicParsing
  } else {
    $PublicUrl = "https://github.com/$Repo/releases/download/$Version/$ZipName"
    try {
      Write-Step "downloading $ZipName (public release asset)"
      Invoke-WebRequest -Uri $PublicUrl -OutFile $ZipPath -UseBasicParsing
    } catch {
      # Private repo fallback: gh CLI downloads with the user's own auth. No token is written or embedded.
      Write-Step "public URL unavailable - falling back to gh release download (private repo, gh auth)"
      & gh release download $Version --repo $Repo --pattern "*.zip" --dir $Temp
      if ($LASTEXITCODE -ne 0) { Die "download failed. Run 'gh auth login' then retry, or set `$env:WXNODUS_BASE_URL to a mirror" }
      $Downloaded = Get-ChildItem $Temp -Filter '*.zip' | Select-Object -First 1
      if (-not $Downloaded) { Die "no zip asset found for $Version" }
      $ZipPath = $Downloaded.FullName
    }
  }
  $Unpack = Join-Path $Temp 'unpacked'
  New-Item -ItemType Directory -Force -Path $Unpack | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $Unpack -Force
  $Inner = Get-ChildItem $Unpack -Recurse -Filter 'install.ps1' | Select-Object -First 1
  if (-not $Inner) { Die "no install.ps1 inside the package (not a wxnodus package)" }
  $Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Inner.FullName)
  if ($InstallDir) { $Args += @('-TargetDir', $InstallDir) }
  if ($NoPath) { $Args += '-SkipPath' }
  if ($BaseUrl) { $Args += @('-Source', "$BaseUrl/$ZipName") }
  Write-Step "installing to $InstallDir"
  & powershell.exe @Args
  exit $LASTEXITCODE
} finally {
  Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
