# cmd-audit.ps1 — 真实 cmd.exe（conhost）环境 UX 审计：/help → CJK 输入 → 真实提交回复
# 产物：artifacts/cmd-audit/（窗口截图 + 屏幕缓冲文本；视觉层由 GLM-4V 识别截图）
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win-common.ps1"
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $ROOT 'artifacts\cmd-audit'
[void](New-Item -ItemType Directory -Force -Path $outDir)

function Save-Frame($hwnd, [string]$name) {
  try { Save-WindowZoom $hwnd (Join-Path $outDir "$name.png") 2 } catch { Write-Output ("shot fail " + $name + ': ' + $_.Exception.Message) }
  try {
    $accessOut = [Convert]::ToUInt32('C0000000', 16)
    $shareOut = [Convert]::ToUInt32('3', 16)
    $conOut = [WxWin]::CreateFile('CONOUT$', $accessOut, $shareOut, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
    if ($conOut -ne [IntPtr]::Zero -and $conOut -ne [IntPtr](-1)) {
      $bufText = [WxWin]::ReadBufferText($conOut)
      [System.IO.File]::WriteAllText((Join-Path $outDir "$name.txt"), $bufText, (New-Object System.Text.UTF8Encoding($true)))
    }
  } catch { Write-Output ("buf fail " + $name + ': ' + $_.Exception.Message) }
}

function Push-Keys($stdin, $records) {
  $written = 0
  $ok = [WxWin]::WriteConsoleInputW($stdin, $records.ToArray(), [uint32]$records.Count, [ref]$written)
  if (-not $ok) { throw ('WriteConsoleInputW failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
}

Clear-StaleTui
$tui = Start-TuiWindow $ROOT
$proc = $tui.proc
$hwnd = $tui.hwnd
try {
  [void][WxWin]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 600
  $stdin = Get-ConsoleInput ([uint32]$proc.Id)

  # 帧 0：就绪态
  Start-Sleep -Seconds 4
  Save-Frame $hwnd '02-ready'

  # 帧 1：/help 建议面板（不含 Enter）→ 再 Enter 执行 → pager
  $r = New-Object System.Collections.Generic.List[object]
  New-UnicodeKeys '/help ' $r
  Push-Keys $stdin $r
  Start-Sleep -Seconds 2
  Save-Frame $hwnd '03-help-suggest'
  $r2 = New-Object System.Collections.Generic.List[object]
  New-EnterKeys $r2
  Push-Keys $stdin $r2
  Start-Sleep -Seconds 3
  Save-Frame $hwnd '04-help-pager'

  # 关 pager（q）
  $r3 = New-Object System.Collections.Generic.List[object]
  New-UnicodeKeys 'q' $r3
  Push-Keys $stdin $r3
  Start-Sleep -Seconds 2

  # 帧 2：CJK 输入（你好，不提交）
  $r4 = New-Object System.Collections.Generic.List[object]
  New-UnicodeKeys '你好' $r4
  Push-Keys $stdin $r4
  Start-Sleep -Seconds 2
  Save-Frame $hwnd '05-cjk-input'

  # 帧 3：真实提交 hello（清空后输入并 Enter；busy 6s + 完成后 10s）
  $r5 = New-Object System.Collections.Generic.List[object]
  New-UnicodeKeys 'hello' $r5
  Push-Keys $stdin $r5
  Start-Sleep -Seconds 1
  $r6 = New-Object System.Collections.Generic.List[object]
  New-EnterKeys $r6
  Push-Keys $stdin $r6
  Start-Sleep -Seconds 6
  Save-Frame $hwnd '06-reply-busy'
  Start-Sleep -Seconds 10
  Save-Frame $hwnd '07-reply-done'

  Write-Output ('audit done pid=' + $proc.Id + ' hwnd=' + $hwnd)
} finally {
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
}
