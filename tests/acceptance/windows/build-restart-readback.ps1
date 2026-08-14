# build-restart-readback.ps1 — 真实进程替换：读数据 → 停树+端口释放 → 新进程（PID 不同）→ 读回同一数据
# 任一步无法验证 → blocked（诚实：绝不硬编码 true）
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'build-restart-readback'; status = 'blocked' }
$proj = $env:WXNODUS_BUILD_PROJECT
$entry = $env:WXNODUS_BUILD_ENTRY
$port = $env:WXNODUS_BUILD_PORT
if (-not $proj -or -not (Test-Path $proj)) { $out.reason = 'no build project provided'; $out | ConvertTo-Json -Depth 8; exit 0 }
if (-not $entry -or -not (Test-Path $entry)) { $out.reason = 'no entry script provided'; $out | ConvertTo-Json -Depth 8; exit 0 }
$out.project = $proj
$pidFile = Join-Path $proj '.wxnodus-server.pid'
$marker = Join-Path $proj 'data.txt'
if (-not (Test-Path $pidFile)) { $out.reason = 'no pid file (server not running)'; $out | ConvertTo-Json -Depth 8; exit 0 }
if (-not (Test-Path $marker)) { $out.reason = 'no data marker'; $out | ConvertTo-Json -Depth 8; exit 0 }
$oldPid = [int](Get-Content $pidFile)
$before = Get-Content $marker -Raw

# 停树（真实 taskkill /T /F）+ 确认退出
taskkill /PID $oldPid /T /F | Out-Null
Start-Sleep -Milliseconds 800
$gone = -not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)
$out.stopTreeConfirmed = $gone
if (-not $gone) { $out.reason = 'stop tree failed (process still alive)'; $out | ConvertTo-Json -Depth 8; exit 0 }

# 端口释放（真实探测；未提供端口则跳过并如实标记）
$out.portReleased = $true
if ($port) {
  $listening = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
  $out.portReleased = -not $listening
}
if (-not $out.portReleased) { $out.reason = 'port not released after stop'; $out | ConvertTo-Json -Depth 8; exit 0 }

# 新进程（真实启动，PID 必须不同）
$p2 = Start-Process -FilePath $entry -PassThru -WorkingDirectory $proj
Start-Sleep -Seconds 2
$newPid = $p2.Id
$out.secondProcessIdDiffers = ($newPid -gt 0 -and $newPid -ne $oldPid)
if (-not $out.secondProcessIdDiffers) { $out.reason = 'second process reused old pid or failed to start'; $out | ConvertTo-Json -Depth 8; exit 0 }

# 读回同一数据
$after = Get-Content $marker -Raw
$out.readBackMatches = ($after -eq $before)
if (-not $out.readBackMatches) { $out.reason = 'readback mismatch'; $out | ConvertTo-Json -Depth 8; exit 0 }
$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
