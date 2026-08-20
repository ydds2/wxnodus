# ime-console-inject.ps1 — TUI 中文输入管线验证（console 输入缓冲注入，公共库版）
# 自包含：起真实 TUI 窗口 → 前台化 → WriteConsoleInputW 注入「你好」+ Enter（Unicode KEY_EVENT
# 记录——OS IME 提交后 conhost 投递应用的同一通道）→ 屏幕缓冲/截图存证。
# 诚实语义：本通道不经过 TSF 候选窗（候选窗需真人真机或未被反作弊拦截的键流），产物如实标注。
# P/Invoke 与截图/窗口工具见 scripts/win-common.ps1（四个证据脚本共用，减轻重复样板）。
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win-common.ps1"
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $ROOT 'artifacts\ime-evidence'
[void](New-Item -ItemType Directory -Force -Path $outDir)

$out = [ordered]@{ kind = 'ime-console-inject'; status = 'blocked' }
$proc = $null
try {
  Clear-StaleTui
  $tui = Start-TuiWindow $ROOT
  $proc = $tui.proc
  $hwnd = $tui.hwnd
  Start-Sleep -Seconds 2
  [void][WxWin]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 600

  $stdin = Get-ConsoleInput ([uint32]$proc.Id)

  # 组装 KEY_EVENT 序列：你 好 + Enter（公共库函数）
  $records = New-Object System.Collections.Generic.List[object]
  New-UnicodeKeys '你好' $records
  # 先只写字符（不含 Enter）→ 截「上屏态」证据图（输入框内已渲染 你好）
  $charsOnly = $records.ToArray()
  $written = 0
  $ok = [WxWin]::WriteConsoleInputW($stdin, $charsOnly, [uint32]$charsOnly.Length, [ref]$written)
  Start-Sleep -Seconds 2
  $b1 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp1 = New-Object System.Drawing.Bitmap($b1.Width, $b1.Height)
  $g1 = [System.Drawing.Graphics]::FromImage($bmp1)
  $g1.CopyFromScreen($b1.Location, [System.Drawing.Point]::Empty, $b1.Size)
  $bmp1.Save((Join-Path $outDir 'ime-unicode-input.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $g1.Dispose(); $bmp1.Dispose()
  Save-WindowZoom $hwnd (Join-Path $outDir 'ime-unicode-input-win.png') 3
  Save-StripShot $hwnd (Join-Path $outDir 'ime-unicode-input-strip.png')

  # 第二次只写 Enter 两条（字符已在上一轮写入——避免重复输入）
  New-EnterKeys $records
  $enterOnly = New-Object System.Collections.Generic.List[object]
  $enterOnly.Add($records[4]); $enterOnly.Add($records[5])
  $arr = $enterOnly.ToArray()
  $written = 0
  $ok = [WxWin]::WriteConsoleInputW($stdin, $arr, [uint32]$arr.Length, [ref]$written)
  Start-Sleep -Seconds 4
  Save-Screenshot (Join-Path $outDir 'ime-unicode-submitted.png')
  Save-WindowZoom $hwnd (Join-Path $outDir 'ime-unicode-submitted-win.png') 3

  # 屏幕缓冲全文（conhost 活动缓冲 = TUI 渲染结果的确定性快照——不依赖前台/不被遮挡）
  $accessOut = [Convert]::ToUInt32('C0000000', 16)
  $shareOut = [Convert]::ToUInt32('3', 16)
  $conOut = [WxWin]::CreateFile('CONOUT$', $accessOut, $shareOut, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($conOut -ne [IntPtr]::Zero -and $conOut -ne [IntPtr](-1)) {
    $bufText = [WxWin]::ReadBufferText($conOut)
    [System.IO.File]::WriteAllText((Join-Path $outDir 'ime-screen-buffer.txt'), $bufText, (New-Object System.Text.UTF8Encoding($true)))
    $out.screenBufferChars = $bufText.Length
    $out.screenBufferHasNihao = ($bufText -match '你好')
  }

  $out.status = 'captured'
  $out.writeOk = $ok
  $out.written = $written
  $out.foregroundVerified = ([WxWin]::GetForegroundWindow() -eq $hwnd)
  $out.tuiPid = $proc.Id
} catch {
  $msg = $_.Exception.Message
  if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
  $out.reason = $msg
} finally {
  if ($proc) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
}
$out | ConvertTo-Json -Depth 4
