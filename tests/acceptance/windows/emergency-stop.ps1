# emergency-stop.ps1 — 全局急停（真实执行）：终止目标进程树 → 确认无残留 → passed；无目标/终止失败 → blocked
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'emergency-stop'; status = 'blocked' }
$targetPid = $env:WXNODUS_EMERGENCY_TARGET_PID
if (-not $targetPid) { $out.reason = 'no emergency-stop target pid provided (fixture harness missing)'; $out | ConvertTo-Json -Depth 8; exit 0 }
$proc = Get-Process -Id ([int]$targetPid) -ErrorAction SilentlyContinue
if (-not $proc) { $out.reason = 'target process not found'; $out | ConvertTo-Json -Depth 8; exit 0 }
# 真实急停：终止进程树
taskkill /PID ([int]$targetPid) /T /F | Out-Null
Start-Sleep -Milliseconds 800
$gone = -not (Get-Process -Id ([int]$targetPid) -ErrorAction SilentlyContinue)
$out.treeTerminated = $gone
if (-not $gone) {
  $out.reason = 'emergency stop failed to terminate process tree'
  $out | ConvertTo-Json -Depth 8
  exit 0
}
$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
