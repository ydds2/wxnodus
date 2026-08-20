# diag-windows.ps1 — 诊断（公共库版）：枚举所有可见顶层窗口（标题/类/PID/前台），并截屏存 evidence
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/diag-windows.ps1 [secondsToWait]
param([int]$WaitSeconds = 8)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win-common.ps1"
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $ROOT 'artifacts\ime-evidence'
[void](New-Item -ItemType Directory -Force -Path $outDir)
Start-Sleep -Seconds $WaitSeconds
$rows = @()
$fg = [WxWin]::GetForegroundWindow()
$cb = [WxWin+EnumProc]{ param($h, $l)
  if (-not [WxWin]::IsWindowVisible($h)) { return $true }
  $t = New-Object System.Text.StringBuilder 256
  $c = New-Object System.Text.StringBuilder 256
  [void][WxWin]::GetWindowText($h, $t, 256)
  [void][WxWin]::GetClassName($h, $c, 256)
  $pid2 = 0; [void][WxWin]::GetWindowThreadProcessId($h, [ref]$pid2)
  $r = New-Object WxWin+RECT
  [void][WxWin]::GetWindowRect($h, [ref]$r)
  $script:rows += [ordered]@{
    hwnd = ('0x{0:X}' -f $h.ToInt64()); title = $t.ToString(); cls = $c.ToString(); pid = $pid2;
    rect = ('{0},{1} {2}x{3}' -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top));
    foreground = ($h -eq $fg)
  }
  return $true
}
[void][WxWin]::EnumWindows($cb, [IntPtr]::Zero)
Save-Screenshot (Join-Path $outDir 'diag-desktop.png')
[ordered]@{ kind = 'windows-diag'; foreground = ('0x{0:X}' -f $fg.ToInt64()); windows = $rows } | ConvertTo-Json -Depth 5
