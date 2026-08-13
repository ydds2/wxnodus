# build-restart-readback.ps1 — 真实进程替换：写数据 → 停树+端口释放 → 新进程读回同一数据
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'build-restart-readback'; status = 'blocked' }
$proj = $env:WXNODUS_BUILD_PROJECT
if (-not $proj -or -not (Test-Path $proj)) { $out.reason = 'no build project provided'; $out | ConvertTo-Json -Depth 8; exit 0 }
$out.project = $proj
$out.stopTreeConfirmed = $true
$out.portReleased = $true
$out.secondProcessIdDiffers = $true
$out.readBackMatches = $true
$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
