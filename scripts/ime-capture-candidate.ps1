# ime-capture-candidate.ps1 — 真人输入守望：候选窗出现瞬间自动截图（真实证据采集，公共库版）
# 背景：反作弊拦截自动化键注入，候选窗只能由真人键盘触发——本脚本只负责「守望+采集」，
# 不注入任何输入。轮询顶层窗口，一旦出现可见的 IME 候选窗（MSCTFIME UI，rect>10x10）
# 立即截图候选窗本体 + TUI 窗口全貌存证。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ime-capture-candidate.ps1 <tuiHwnd> <timeoutSec>
param([int64]$TuiHwnd, [int]$TimeoutSec = 300)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win-common.ps1"
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $ROOT 'artifacts\ime-evidence'
[void](New-Item -ItemType Directory -Force -Path $outDir)

function Shot-Rect([int]$l, [int]$t, [int]$w, [int]$h, [string]$path) {
  if ($w -le 0 -or $h -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return $true
}
$out = [ordered]@{ kind = 'ime-human-candidate-watch'; status = 'timeout'; found = $false }
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$tui = [IntPtr]$TuiHwnd
while ((Get-Date) -lt $deadline) {
  $script:cand = $null
  $cb = [WxWin+EnumProc]{ param($h, $l)
    $cls = New-Object System.Text.StringBuilder 256
    [void][WxWin]::GetClassName($h, $cls, 256)
    if ($cls.ToString() -eq 'MSCTFIME UI' -and [WxWin]::IsWindowVisible($h)) {
      $r = New-Object WxWin+RECT
      [void][WxWin]::GetWindowRect($h, [ref]$r)
      if (($r.Right - $r.Left) -gt 10 -and ($r.Bottom - $r.Top) -gt 10) { $script:cand = @{ hwnd=$h; r=$r } }
    }
    return $true
  }
  [void][WxWin]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:cand) {
    $r = $script:cand.r
    $candPath = Join-Path $outDir 'ime-candidate-human.png'
    if (Shot-Rect $r.Left $r.Top ($r.Right - $r.Left) ($r.Bottom - $r.Top) $candPath) {
      # 候选窗截图成功后立即补一张 TUI 窗口全貌（输入上下文证据）
      $tr = New-Object WxWin+RECT
      if ([WxWin]::GetWindowRect($tui, [ref]$tr)) {
        Shot-Rect $tr.Left $tr.Top ($tr.Right - $tr.Left) ($tr.Bottom - $tr.Top) (Join-Path $outDir 'ime-candidate-human-tui.png') | Out-Null
      }
      $out.status = 'captured'
      $out.found = $true
      $out.candidateWindow = @{ hwnd = ('0x{0:X}' -f $script:cand.hwnd.ToInt64()); rect = ('{0},{1} {2}x{3}' -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)) }
      break
    }
  }
  Start-Sleep -Milliseconds 250
}
$out | ConvertTo-Json -Depth 4
