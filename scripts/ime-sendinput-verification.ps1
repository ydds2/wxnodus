# ime-sendinput-verification.ps1 — IME 真机验证（自动化，公共库版）：SendInput 真实键流经真实 TSF/IME 管线
# 流程：真实 conhost 窗口跑 wxnodus TUI → 前台化（ALT 技巧破前台锁 + 重试校验）→
# 切换中文输入法（WM_INPUTLANGCHANGEREQUEST，00000804 微软拼音）→ SendInput 'nihao' →
# 真实候选窗出现（截图证据）→ Space 上屏「你好」→ 截图 → Enter 提交 → 截图。
# 诚实语义：本脚本只负责「真实管线采集证据」，状态恒为 captured——内容核验（候选窗是否出现、
# 上屏是否中文、回显是否完整）由 scripts/ime-vision-verify.mjs 机器视觉执行，绝不本脚本自签通过。
# 任一步采集失败（窗口不可见/前台化失败/截图失败）→ status=blocked 如实输出原因。
# 本机边界：反作弊拦截 SendInput（err=87）——真实键流通道当前不可用，见 injection-blocked.json；
# 可用通道为 ime-console-inject.ps1（WriteConsoleInputW）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ime-sendinput-verification.ps1 [-AsciiProbe]
param([switch]$AsciiProbe)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win-common.ps1"
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $ROOT 'artifacts\ime-evidence'
[void](New-Item -ItemType Directory -Force -Path $outDir)

$WM_INPUTLANGCHANGEREQUEST = 0x0050
$KLF_ACTIVATE = 0x00000001

$out = [ordered]@{ kind = 'ime-sendinput-capture'; status = 'blocked' }
$proc = $null
$oldLayout = [WxWin]::GetKeyboardLayout(0)
try {
  Clear-StaleTui
  $tui = Start-TuiWindow $ROOT
  $proc = $tui.proc
  $hwnd = $tui.hwnd
  Start-Sleep -Seconds 2

  # 前台化：ALT 键技巧破前台锁 + 校验真前台（失败则 blocked，不继续伪造输入）
  $fg = $false
  foreach ($i in 1..5) {
    [void](Send-Key 0x12) # ALT press/release（解锁前台限制）
    [void][WxWin]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    if ([WxWin]::GetForegroundWindow() -eq $hwnd) { $fg = $true; break }
  }
  if (-not $fg) { throw 'foreground acquisition failed (foreground lock) — 输入未送达，拒绝伪证' }

  # AsciiProbe 对照实验：不切换输入法，纯 ASCII 键流——验证「输入链路本身通不通」
  if ($AsciiProbe) {
    foreach ($ch in [char[]]'hello') { [void](Send-Key ([WxWin]::VkKeyScan($ch))) }
    Start-Sleep -Milliseconds 800
    Save-Screenshot (Join-Path $outDir 'ime-ascii-input.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-ascii-input-win.png') 3
    [void](Send-Key 0x0D)
    Start-Sleep -Seconds 3
    Save-Screenshot (Join-Path $outDir 'ime-ascii-submitted.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-ascii-submitted-win.png') 3
    $out.kind = 'ime-ascii-probe'
    $out.status = 'captured'
    $out.evidence = [ordered]@{
      foregroundVerified = $true
      asciiInput = [ordered]@{ file = 'ime-ascii-input.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-ascii-input.png') }
      asciiSubmitted = [ordered]@{ file = 'ime-ascii-submitted.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-ascii-submitted.png') }
    }
  } else {
    # 切换中文输入法（微软拼音 00000804）——真实 TSF/IME 管线
    $zh = [WxWin]::LoadKeyboardLayout('00000804', $KLF_ACTIVATE)
    [void][WxWin]::PostMessage($hwnd, $WM_INPUTLANGCHANGEREQUEST, [IntPtr]0, $zh)
    Start-Sleep -Milliseconds 1000
    $layout = [WxWin]::GetKeyboardLayout(0).ToInt64() -band 0xFFFF

    foreach ($ch in [char[]]'nihao') { [void](Send-Key ([WxWin]::VkKeyScan($ch))) }
    Start-Sleep -Milliseconds 1200
    Save-Screenshot (Join-Path $outDir 'ime-candidate.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-candidate-win.png') 3

    # Space 选第一候选上屏
    [void](Send-Key 0x20)
    Start-Sleep -Milliseconds 800
    Save-Screenshot (Join-Path $outDir 'ime-committed.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-committed-win.png') 3

    # Enter 提交消息
    [void](Send-Key 0x0D)
    Start-Sleep -Seconds 3
    Save-Screenshot (Join-Path $outDir 'ime-submitted.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-submitted-win.png') 3

    $out.status = 'captured'
    $out.evidence = [ordered]@{
      foregroundVerified = $true
      layoutAfterSwitch = ('0x{0:X4}' -f $layout)
      candidate = [ordered]@{ file = 'ime-candidate.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-candidate.png') }
      committed = [ordered]@{ file = 'ime-committed.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-committed.png') }
      submitted = [ordered]@{ file = 'ime-submitted.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-submitted.png') }
      candidateWin = [ordered]@{ file = 'ime-candidate-win.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-candidate-win.png') }
      committedWin = [ordered]@{ file = 'ime-committed-win.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-committed-win.png') }
      submittedWin = [ordered]@{ file = 'ime-submitted-win.png'; sha256 = Get-Sha256 (Join-Path $outDir 'ime-submitted-win.png') }
    }
    $out.next = 'node scripts/ime-vision-verify.mjs'
  }
} catch {
  $msg = $_.Exception.Message
  if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
  $out.reason = $msg
} finally {
  # 还原输入法
  try { if ($hwnd) { [void][WxWin]::PostMessage($hwnd, $WM_INPUTLANGCHANGEREQUEST, [IntPtr]0, $oldLayout) } } catch {}
  if ($proc) {
    try { Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $proc.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}
$out | ConvertTo-Json -Depth 5
