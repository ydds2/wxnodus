# ime-console-inject.ps1 — TUI 中文输入管线验证（console 输入缓冲注入）
# 自包含：起真实 TUI 窗口 → 前台化 → FreeConsole+AttachConsole(TUI) → WriteConsoleInputW 注入
# 「你好」+ Enter（Unicode KEY_EVENT 记录——OS IME 提交后 conhost 投递到应用的同一通道）→ 截图。
# 诚实语义：本通道不经过 TSF 候选窗（候选窗需真人真机或未被反作弊拦截的键流），产物如实标注。
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CInj {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buffer, uint length, out uint written);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CHAR_INFO { public char UnicodeChar; public short Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO { public COORD dwSize; public COORD dwCursorPosition; public short wAttributes; public SMALL_RECT srWindow; public COORD dwMaximumWindowSize; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadConsoleOutputW(IntPtr h, [Out] CHAR_INFO[] buffer, COORD size, COORD origin, ref SMALL_RECT region);
  // 读取挂载控制台的活动屏幕缓冲全文（conhost 已把 VT 输出渲染成字符——确定性证据，无需截图/前台）
  public static string ReadBufferText(IntPtr h) {
    CONSOLE_SCREEN_BUFFER_INFO info;
    if (!GetConsoleScreenBufferInfo(h, out info)) throw new InvalidOperationException("GetConsoleScreenBufferInfo failed");
    int w = info.dwSize.X, hgt = info.dwSize.Y;
    CHAR_INFO[] buf = new CHAR_INFO[w * hgt];
    SMALL_RECT region = new SMALL_RECT { Left = 0, Top = 0, Right = (short)(w - 1), Bottom = (short)(hgt - 1) };
    COORD size = new COORD { X = (short)w, Y = (short)hgt };
    COORD origin = new COORD { X = 0, Y = 0 };
    if (!ReadConsoleOutputW(h, buf, size, origin, ref region)) throw new InvalidOperationException("ReadConsoleOutputW failed");
    var sb = new System.Text.StringBuilder();
    for (int y = 0; y < hgt; y++) {
      for (int x = 0; x < w; x++) {
        CHAR_INFO cell = buf[y * w + x];
        if ((cell.Attributes & 0x0200) != 0) { continue; } // COMMON_LVB_TRAILING_BYTE：宽字符尾格（0x0200，与主格同字符）
        char c = cell.UnicodeChar; sb.Append(c == '\0' ? ' ' : c);
      }
      sb.AppendLine();
    }
    return sb.ToString();
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static void GetRectVals(IntPtr h, out int left, out int top, out int width, out int height) {
    RECT r; if (!GetWindowRect(h, out r)) throw new InvalidOperationException("GetWindowRect failed");
    left = r.Left; top = r.Top; width = r.Right - r.Left; height = r.Bottom - r.Top;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD {
    public bool bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode; public ushort wVirtualScanCode;
    public char UnicodeChar; public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
}
'@
# 窗口内容截图（CopyFromScreen 矩形裁剪——conhost 对 PrintWindow 返回黑屏；需窗口不被遮挡）
# + 3x 放大（视觉模型读小字号更准）
function Save-ZoomShot([IntPtr]$hwnd, [string]$path) {
  $l = 0; $t = 0; $w = 0; $h = 0
  [CInj]::GetRectVals($hwnd, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
  if ($w -le 0 -or $h -le 0) { throw 'window rect empty' }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $zw = $w * 3; $zh = $h * 3
  $big = New-Object System.Drawing.Bitmap($zw, $zh)
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $zw, $zh)
  $big.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g2.Dispose(); $big.Dispose(); $g.Dispose(); $bmp.Dispose()
}
# 窗口底部条带裁剪（输入框/状态栏区，bottomRatio=0.25）+ 3x 放大
function Save-StripShot([IntPtr]$hwnd, [string]$path) {
  $l = 0; $t = 0; $w = 0; $h = 0
  [CInj]::GetRectVals($hwnd, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
  if ($w -le 0 -or $h -le 0) { throw 'window rect empty' }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $sh = [int]($h * 0.25)
  $rect = New-Object System.Drawing.Rectangle(0, ($h - $sh), $w, $sh)
  $strip = $bmp.Clone($rect, $bmp.PixelFormat)
  $zw = $w * 3; $zh = $sh * 3
  $big = New-Object System.Drawing.Bitmap($zw, $zh)
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($strip, 0, 0, $zw, $zh)
  $big.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g2.Dispose(); $big.Dispose(); $strip.Dispose(); $g.Dispose(); $bmp.Dispose()
}
# ALT 技巧破前台锁 + 校验（截图需要窗口在最上层）
function Ensure-Foreground([IntPtr]$hwnd) {
  foreach ($i in 1..4) {
    $down = New-Object CInj+KEY_EVENT_RECORD
    $down.bKeyDown = $true; $down.wRepeatCount = 1; $down.wVirtualKeyCode = 0x12; $down.dwControlKeyState = 0
    $up = New-Object CInj+KEY_EVENT_RECORD
    $up.bKeyDown = $false; $up.wRepeatCount = 1; $up.wVirtualKeyCode = 0x12; $up.dwControlKeyState = 0
    $alt = New-Object System.Collections.Generic.List[object]
    $a1 = New-Object CInj+INPUT_RECORD; $a1.EventType = 1; $a1.KeyEvent = $down; $alt.Add($a1)
    $a2 = New-Object CInj+INPUT_RECORD; $a2.EventType = 1; $a2.KeyEvent = $up; $alt.Add($a2)
    $w0 = 0
    [void][CInj]::WriteConsoleInputW($stdin, $alt.ToArray(), 2, [ref]$w0)
    [void][CInj]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    if ([CInj]::GetForegroundWindow() -eq $hwnd) { return $true }
  }
  return $false
}
$out = [ordered]@{ kind = 'ime-console-inject'; status = 'blocked' }
$proc = $null
try {
  # 清理残留（同 ime-sendinput-verification.ps1）
  $stale = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist.cli.index' }
  foreach ($s in $stale) {
    Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $s.ProcessId } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500

  # 起真实 TUI（Normal 可见窗口）
  $proc = Start-Process node -ArgumentList 'dist\cli\index.js' -WorkingDirectory $ROOT -PassThru -WindowStyle Normal
  $hwnd = [IntPtr]::Zero
  foreach ($i in 1..20) {
    Start-Sleep -Milliseconds 500
    try { $proc.Refresh() } catch {}
    # MainWindowHandle 可能指向进程的小助手窗（159x27 之类）——取进程+conhost 子进程
    # 所有顶层窗口中面积最大者（真实 console 窗口）
    $mh = $proc.MainWindowHandle
    if ($mh -ne [IntPtr]::Zero) {
      $l = 0; $t = 0; $w = 0; $h = 0
      [CInj]::GetRectVals($mh, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
      if ($w -gt 400 -and $h -gt 200) { $hwnd = $mh; break }
    }
    $conhost = Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $proc.Id } | Select-Object -First 1
    if ($conhost) {
      $script:hwnd = [IntPtr]::Zero
      $script:bestArea = 0
      $cb = [CInj+EnumProc]{ param($h, $l)
        $p = 0; [void][CInj]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq $conhost.ProcessId -or $p -eq $proc.Id) {
          $r2 = New-Object CInj+RECT
          if ([CInj]::GetWindowRect($h, [ref]$r2)) {
            $area = ($r2.Right - $r2.Left) * ($r2.Bottom - $r2.Top)
            if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:hwnd = $h }
          }
        }
        return $true
      }
      [void][CInj]::EnumWindows($cb, [IntPtr]::Zero)
      if ($hwnd -ne [IntPtr]::Zero) { break }
    }
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw 'TUI window not found' }
  Start-Sleep -Seconds 2
  [void][CInj]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 600

  # FreeConsole → AttachConsole(TUI) → CONIN$ 输入缓冲句柄（AttachConsole 后 GetStdHandle 拿到的
  # 仍是本进程旧句柄 err=6——CreateFile("CONIN$") 才是挂载控制台输入缓冲的正确取法）
  if (-not [CInj]::FreeConsole()) { throw ('FreeConsole failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  if (-not [CInj]::AttachConsole([uint32]$proc.Id)) { throw ('AttachConsole failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $access = [Convert]::ToUInt32('C0000000', 16) # GENERIC_READ|GENERIC_WRITE
  $share = [Convert]::ToUInt32('3', 16)         # FILE_SHARE_READ|FILE_SHARE_WRITE
  $stdin = [CInj]::CreateFile('CONIN$', $access, $share, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero) # OPEN_EXISTING
  if ($stdin -eq [IntPtr]::Zero -or $stdin -eq [IntPtr](-1)) { throw ('CreateFile CONIN$ failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }

  # 组装 KEY_EVENT 序列：你 好 + Enter
  $chars = [char[]]'你好'
  $records = New-Object System.Collections.Generic.List[object]
  foreach ($c in $chars) {
    $down = New-Object CInj+KEY_EVENT_RECORD
    $down.bKeyDown = $true; $down.wRepeatCount = 1; $down.wVirtualKeyCode = 0; $down.wVirtualScanCode = 0
    $down.UnicodeChar = $c; $down.dwControlKeyState = 0
    $up = New-Object CInj+KEY_EVENT_RECORD
    $up.bKeyDown = $false; $up.wRepeatCount = 1; $up.wVirtualKeyCode = 0; $up.wVirtualScanCode = 0
    $up.UnicodeChar = [char]0; $up.dwControlKeyState = 0 # KeyUp 不携带字符——防 libuv 双发
    $r1 = New-Object CInj+INPUT_RECORD; $r1.EventType = 1; $r1.KeyEvent = $down; $records.Add($r1)
    $r2 = New-Object CInj+INPUT_RECORD; $r2.EventType = 1; $r2.KeyEvent = $up; $records.Add($r2)
  }
  # 先只写字符（不含 Enter）→ 截「上屏态」证据图（输入框内已渲染 你好）
  $charsOnly = $records.ToArray()
  $written = 0
  $ok = [CInj]::WriteConsoleInputW($stdin, $charsOnly, [uint32]$charsOnly.Length, [ref]$written)
  Start-Sleep -Seconds 2
  $b1 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp1 = New-Object System.Drawing.Bitmap($b1.Width, $b1.Height)
  $g1 = [System.Drawing.Graphics]::FromImage($bmp1)
  $g1.CopyFromScreen($b1.Location, [System.Drawing.Point]::Empty, $b1.Size)
  $bmp1.Save((Join-Path $ROOT 'artifacts\ime-evidence\ime-unicode-input.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $g1.Dispose(); $bmp1.Dispose()
  Save-ZoomShot $hwnd (Join-Path $ROOT 'artifacts\ime-evidence\ime-unicode-input-win.png')
  Save-StripShot $hwnd (Join-Path $ROOT 'artifacts\ime-evidence\ime-unicode-input-strip.png')
  $enterDown = New-Object CInj+KEY_EVENT_RECORD
  $enterDown.bKeyDown = $true; $enterDown.wRepeatCount = 1; $enterDown.wVirtualKeyCode = 0x0D; $enterDown.wVirtualScanCode = 0x1C; $enterDown.UnicodeChar = [char]13; $enterDown.dwControlKeyState = 0
  $enterUp = New-Object CInj+KEY_EVENT_RECORD
  $enterUp.bKeyDown = $false; $enterUp.wRepeatCount = 1; $enterUp.wVirtualKeyCode = 0x0D; $enterUp.wVirtualScanCode = 0x1C; $enterUp.UnicodeChar = [char]0; $enterUp.dwControlKeyState = 0
  $r3 = New-Object CInj+INPUT_RECORD; $r3.EventType = 1; $r3.KeyEvent = $enterDown; $records.Add($r3)
  $r4 = New-Object CInj+INPUT_RECORD; $r4.EventType = 1; $r4.KeyEvent = $enterUp; $records.Add($r4)
  # 第二次只写 Enter 两条（字符已在上一轮写入——避免重复输入）
  $enterOnly = New-Object System.Collections.Generic.List[object]
  $enterOnly.Add($records[4]); $enterOnly.Add($records[5])
  $arr = $enterOnly.ToArray()
  $written = 0
  $ok = [CInj]::WriteConsoleInputW($stdin, $arr, [uint32]$arr.Length, [ref]$written)
  Start-Sleep -Seconds 4
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $ROOT 'artifacts\ime-evidence\ime-unicode-submitted.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Save-ZoomShot $hwnd (Join-Path $ROOT 'artifacts\ime-evidence\ime-unicode-submitted-win.png')

  # 屏幕缓冲全文（conhost 活动缓冲 = TUI 渲染结果的确定性快照——不依赖前台/不被遮挡）
  $accessOut = [Convert]::ToUInt32('C0000000', 16)
  $shareOut = [Convert]::ToUInt32('3', 16)
  $conOut = [CInj]::CreateFile('CONOUT$', $accessOut, $shareOut, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($conOut -ne [IntPtr]::Zero -and $conOut -ne [IntPtr](-1)) {
    $bufText = [CInj]::ReadBufferText($conOut)
    [System.IO.File]::WriteAllText((Join-Path $ROOT 'artifacts\ime-evidence\ime-screen-buffer.txt'), $bufText, (New-Object System.Text.UTF8Encoding($true)))
    $out.screenBufferChars = $bufText.Length
    $out.screenBufferHasNihao = ($bufText -match '你好')
  }

  $out.status = 'captured'
  $out.writeOk = $ok
  $out.written = $written
  $out.foregroundVerified = ([CInj]::GetForegroundWindow() -eq $hwnd)
  $out.tuiPid = $proc.Id
} catch {
  $msg = $_.Exception.Message
  if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
  $out.reason = $msg
} finally {
  if ($proc) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
}
$out | ConvertTo-Json -Depth 4
