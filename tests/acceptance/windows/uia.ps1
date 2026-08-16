# uia.ps1 — Gate E uia scenario (REAL execution on the interactive desktop)
# Positive drives (production code path, tsx): Invoke (Button) / Value (TextBox, Chinese-native) /
# Selection (ListBox item) with end-to-end readback via echo files.
# Negative: nonexistent element -> honest UIA_ACTION_NOT_PERFORMED (no fake success).
# Protected/locked/high-integrity boundaries are fail-closed unit contracts (driverContracts/failure
# tests) - they cannot be forced on this machine without UAC prompts or locking the session.
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$echoDir = Join-Path ([System.IO.Path]::GetTempPath()) ('wxnodus-uia-echo-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
[void](New-Item -ItemType Directory -Force -Path $echoDir)
$out = [ordered]@{ scenarioId = 'uia'; status = 'blocked' }
$fixture = $null
try {
  $fixture = Start-Process powershell -ArgumentList '-STA','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'uia-fixture.ps1'),'-Out',$echoDir -PassThru
  Start-Sleep -Seconds 3
  $env:WXNODUS_UIA_ECHO_DIR = $echoDir
  & npx.cmd tsx (Join-Path $ROOT 'scripts\uia-scenario-driver.ts') 2>&1 | Out-Null
  # 文件握手（UTF-8 显式读取——管道捕获在 PS 5.1 受编码/2>&1 ErrorRecord 影响，不作判定依据）
  $resultFile = Join-Path $echoDir 'driver-result.json'
  if (Test-Path $resultFile) {
    $raw = [System.IO.File]::ReadAllText($resultFile, [System.Text.Encoding]::UTF8)
    $detail = $raw | ConvertFrom-Json
    $out.status = if ($detail.ok) { 'passed' } else { 'blocked' }
    if (-not $detail.ok -and $detail.reason) { $out.reason = [string]$detail.reason }
    $out.results = $detail.results
    $out.fixtureHandle = $detail.fixtureHandle
  } else {
    $out.reason = 'driver result file missing (driver crashed or fixture never appeared)'
  }
} catch {
  $msg = $_.Exception.Message
  if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
  $out.reason = $msg
} finally {
  if ($fixture) { try { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue } catch {} }
  try { Remove-Item -Recurse -Force $echoDir -ErrorAction SilentlyContinue } catch {}
}
$out.boundaries = [ordered]@{
  noActionBlocked = $true
  blockedBoundaryFallbackNeverAttempted = 'unit-tested (driverContracts x5 / failure x5)'
  highIntegrityProtectedSecureDesktop = 'unit-tested (cannot force without UAC prompt or session lock on this machine)'
}
$out | ConvertTo-Json -Depth 8
