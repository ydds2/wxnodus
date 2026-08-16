# ime-sendinput-verification.ps1 — IME 真机验证（自动化）：SendInput 真实键流经真实 TSF/IME 管线
# 流程：cmd 窗口（标题 WxNodusIME）跑 wxnodus TUI → 前台化（ALT 技巧破前台锁 + 重试校验）→
# 切换中文输入法（WM_INPUTLANGCHANGEREQUEST，00000804 微软拼音）→ SendInput 'nihao' →
# 真实候选窗出现（截图证据）→ Space 上屏「你好」→ 截图 → Enter 提交 → 截图。
# 诚实语义：本脚本只负责「真实管线采集证据」，状态恒为 captured——内容核验（候选窗是否出现、
# 上屏是否中文、回显是否完整）由 scripts/ime-vision-verify.mjs 机器视觉执行，绝不本脚本自签通过。
# 任一步采集失败（窗口不可见/前台化失败/截图失败）→ status=blocked 如实输出原因。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ime-sendinput-verification.ps1 [-AsciiProbe]
param([switch]$AsciiProbe)
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $ROOT 'artifacts\ime-evidence'
[void](New-Item -ItemType Directory -Force -Path $outDir)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ImeV {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string pwszKLID, uint Flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern ushort VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static void GetRectVals(IntPtr h, out int left, out int top, out int width, out int height) {
    RECT r; if (!GetWindowRect(h, out r)) throw new InvalidOperationException("GetWindowRect failed");
    left = r.Left; top = r.Top; width = r.Right - r.Left; height = r.Bottom - r.Top;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type; public KEYBDINPUT ki;
  }
}
'@
$INPUT_KEYBOARD = 1
$KEYEVENTF_KEYUP = 0x0002
$WM_INPUTLANGCHANGEREQUEST = 0x0050
$KLF_ACTIVATE = 0x00000001
$SW_RESTORE = 9

function Send-Key([uint16]$vk) {
  $down = New-Object ImeV+INPUT
  $down.type = $INPUT_KEYBOARD
  $down.ki.wVk = $vk
  $up = New-Object ImeV+INPUT
  $up.type = $INPUT_KEYBOARD
  $up.ki.wVk = $vk
  $up.ki.dwFlags = $KEYEVENTF_KEYUP
  [void][ImeV]::SendInput(1, [ImeV+INPUT[]]@($down), [System.Runtime.InteropServices.Marshal]::SizeOf([type][ImeV+INPUT]))
  [void][ImeV]::SendInput(1, [ImeV+INPUT[]]@($up), [System.Runtime.InteropServices.Marshal]::SizeOf([type][ImeV+INPUT]))
}

function Save-Screenshot([string]$path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

# 窗口裁剪 + 放大：小字号终端文字交给视觉模型前放大，读得准
function Save-WindowZoom([IntPtr]$hwnd, [string]$path, [int]$zoom) {
  $l = 0; $t = 0; $w = 0; $h = 0
  [ImeV]::GetRectVals($hwnd, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
  if ($w -le 0 -or $h -le 0) { throw 'window rect empty' }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $zw = $w * $zoom; $zh = $h * $zoom
  $big = New-Object System.Drawing.Bitmap($zw, $zh)
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $zw, $zh)
  $big.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g2.Dispose(); $big.Dispose(); $g.Dispose(); $bmp.Dispose()
}

function Get-Sha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.IO.File]::ReadAllBytes($path)
  ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
}

$out = [ordered]@{ kind = 'ime-sendinput-capture'; status = 'blocked' }
$proc = $null
$oldLayout = [ImeV]::GetKeyboardLayout(0)
try {
  # 清理上一轮残留（node TUI 进程 + 其 conhost 僵尸窗口——僵尸窗会顶掉本次窗口定位）
  $stale = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist.cli.index' }
  foreach ($s in $stale) {
    Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $s.ProcessId } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500

  # 真实 conhost 窗口：Normal 启动（Minimized 启动的 console 窗不重绘=黑窗）
  $proc = Start-Process node -ArgumentList 'dist\cli\index.js' -WorkingDirectory $ROOT -PassThru -WindowStyle Normal
  $hwnd = [IntPtr]::Zero
  foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 500
    # 主通道：node 进程的 MainWindowHandle（conhost 窗口随行）；要求 rect>0 防 0x0 假窗
    try { $proc.Refresh() } catch {}
    $mh = $proc.MainWindowHandle
    if ($mh -ne [IntPtr]::Zero) {
      $l = 0; $t = 0; $w = 0; $h = 0
      [ImeV]::GetRectVals($mh, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
      if ($w -gt 0 -and $h -gt 0) { $hwnd = $mh; break }
    }
    # 兜底：conhost 子进程 → 枚举其窗口取面积最大者（跳过 IME 0x0 助手窗）
    $conhost = Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $proc.Id } | Select-Object -First 1
    if ($conhost) {
      $script:hwnd = [IntPtr]::Zero
      $script:bestArea = 0
      $cb = [ImeV+EnumProc]{ param($h, $l)
        $p = 0; [void][ImeV]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq $conhost.ProcessId) {
          $r2 = New-Object ImeV+RECT
          if ([ImeV]::GetWindowRect($h, [ref]$r2)) {
            $area = ($r2.Right - $r2.Left) * ($r2.Bottom - $r2.Top)
            if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:hwnd = $h }
          }
        }
        return $true
      }
      [void][ImeV]::EnumWindows($cb, [IntPtr]::Zero)
      if ($hwnd -ne [IntPtr]::Zero) { break }
    }
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw 'TUI window not found' }
  Start-Sleep -Seconds 2

  # 前台化：ALT 键技巧破前台锁 + 校验真前台（失败则 blocked，不继续伪造输入）
  $fg = $false
  foreach ($i in 1..5) {
    Send-Key 0x12 # ALT press/release（解锁前台限制）
    [void][ImeV]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    if ([ImeV]::GetForegroundWindow() -eq $hwnd) { $fg = $true; break }
  }
  if (-not $fg) { throw 'foreground acquisition failed (foreground lock) — 输入未送达，拒绝伪证' }

  # AsciiProbe 对照实验：不切换输入法，纯 ASCII 键流——验证「输入链路本身通不通」
  if ($AsciiProbe) {
    foreach ($ch in [char[]]'hello') { Send-Key ([ImeV]::VkKeyScan($ch)) }
    Start-Sleep -Milliseconds 800
    Save-Screenshot (Join-Path $outDir 'ime-ascii-input.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-ascii-input-win.png') 3
    Send-Key 0x0D
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
    $zh = [ImeV]::LoadKeyboardLayout('00000804', $KLF_ACTIVATE)
    [void][ImeV]::PostMessage($hwnd, $WM_INPUTLANGCHANGEREQUEST, [IntPtr]0, $zh)
    Start-Sleep -Milliseconds 1000
    $layout = [ImeV]::GetKeyboardLayout(0).ToInt64() -band 0xFFFF

    foreach ($ch in [char[]]'nihao') { Send-Key ([ImeV]::VkKeyScan($ch)) }
    Start-Sleep -Milliseconds 1200
    Save-Screenshot (Join-Path $outDir 'ime-candidate.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-candidate-win.png') 3

    # Space 选第一候选上屏
    Send-Key 0x20
    Start-Sleep -Milliseconds 800
    Save-Screenshot (Join-Path $outDir 'ime-committed.png')
    Save-WindowZoom $hwnd (Join-Path $outDir 'ime-committed-win.png') 3

    # Enter 提交消息
    Send-Key 0x0D
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
  try { if ($hwnd) { [void][ImeV]::PostMessage($hwnd, $WM_INPUTLANGCHANGEREQUEST, [IntPtr]0, $oldLayout) } } catch {}
  if ($proc) {
    try { Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $proc.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}
$out | ConvertTo-Json -Depth 5
