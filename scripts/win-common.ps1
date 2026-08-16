# scripts/win-common.ps1 — PowerShell 证据脚本公共库（C# P/Invoke 类型 + 截图/窗口/键流/控制台工具）
# 被 ime-console-inject.ps1 / ime-sendinput-verification.ps1 / ime-capture-candidate.ps1 / diag-windows.ps1 dot-source
# （. "$PSScriptRoot\win-common.ps1"）——消除四个脚本的重复 P/Invoke 样板。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WxWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string pwszKLID, uint Flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern ushort VkKeyScan(char ch);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buffer, uint length, out uint written);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadConsoleOutputW(IntPtr h, [Out] CHAR_INFO[] buffer, COORD size, COORD origin, ref SMALL_RECT region);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CHAR_INFO { public char UnicodeChar; public short Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO { public COORD dwSize; public COORD dwCursorPosition; public short wAttributes; public SMALL_RECT srWindow; public COORD dwMaximumWindowSize; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD { public bool bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode; public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState; }
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] public struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent; }
  public static void GetRectVals(IntPtr h, out int left, out int top, out int width, out int height) {
    RECT r; if (!GetWindowRect(h, out r)) throw new InvalidOperationException("GetWindowRect failed");
    left = r.Left; top = r.Top; width = r.Right - r.Left; height = r.Bottom - r.Top;
  }
  // 读取挂载控制台的活动屏幕缓冲全文（conhost 已把 VT 输出渲染成字符——确定性证据）
  // 宽字符尾格（COMMON_LVB_TRAILING_BYTE 0x0200，与主格同字符）跳过
  public static string ReadBufferText(IntPtr h) {
    CONSOLE_SCREEN_BUFFER_INFO info;
    if (!GetConsoleScreenBufferInfo(h, out info)) throw new InvalidOperationException("GetConsoleScreenBufferInfo failed");
    int w = info.dwSize.X, hgt = info.dwSize.Y;
    CHAR_INFO[] buf = new CHAR_INFO[w * hgt];
    SMALL_RECT region = new SMALL_RECT { Left = 0, Top = 0, Right = (short)(w - 1), Bottom = (short)(hgt - 1) };
    COORD size = new COORD { X = (short)w, Y = (short)hgt };
    COORD origin = new COORD { X = 0, Y = 0 };
    if (!ReadConsoleOutputW(h, buf, size, origin, ref region)) throw new InvalidOperationException("ReadConsoleOutputW failed");
    var sb = new StringBuilder();
    for (int y = 0; y < hgt; y++) {
      for (int x = 0; x < w; x++) {
        CHAR_INFO cell = buf[y * w + x];
        if ((cell.Attributes & 0x0200) != 0) { continue; }
        char c = cell.UnicodeChar; sb.Append(c == '\0' ? ' ' : c);
      }
      sb.AppendLine();
    }
    return sb.ToString();
  }
}
'@

# ── 通用函数 ──
function Get-Sha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.IO.File]::ReadAllBytes($path)
  ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
}

function Save-Screenshot([string]$path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

# 窗口内容截图（CopyFromScreen 矩形裁剪——conhost 对 PrintWindow 返回黑屏；需窗口不被遮挡）+ 放大
function Save-WindowZoom([IntPtr]$hwnd, [string]$path, [int]$zoom) {
  $l = 0; $t = 0; $w = 0; $h = 0
  [WxWin]::GetRectVals($hwnd, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
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

# 窗口底部条带裁剪（输入框/状态栏区，bottomRatio=0.25）+ 放大
function Save-StripShot([IntPtr]$hwnd, [string]$path) {
  $l = 0; $t = 0; $w = 0; $h = 0
  [WxWin]::GetRectVals($hwnd, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
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

# SendInput 键（down/up 成对；返回是否全部写入）
function Send-Key([uint16]$vk) {
  $down = New-Object WxWin+INPUT
  $down.type = 1
  $down.ki.wVk = $vk
  $up = New-Object WxWin+INPUT
  $up.type = 1
  $up.ki.wVk = $vk
  $up.ki.dwFlags = 2 # KEYEVENTF_KEYUP
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WxWin+INPUT])
  $r1 = [WxWin]::SendInput(1, [WxWin+INPUT[]]@($down), $size)
  $r2 = [WxWin]::SendInput(1, [WxWin+INPUT[]]@($up), $size)
  return ($r1 -eq 1 -and $r2 -eq 1)
}

# FreeConsole → AttachConsole(pid) → CONIN$ 输入缓冲句柄（CreateFile 才是挂载控制台输入缓冲的正确取法）
function Get-ConsoleInput([uint32]$TargetPid) {
  if (-not [WxWin]::FreeConsole()) { throw ('FreeConsole failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  if (-not [WxWin]::AttachConsole($TargetPid)) { throw ('AttachConsole failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $access = [Convert]::ToUInt32('C0000000', 16) # GENERIC_READ|GENERIC_WRITE
  $share = [Convert]::ToUInt32('3', 16)         # FILE_SHARE_READ|FILE_SHARE_WRITE
  $h = [WxWin]::CreateFile('CONIN$', $access, $share, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) { throw ('CreateFile CONIN$ failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  return $h
}

# 组装 Unicode 键事件（字符 down/up，KeyUp 不携带字符防 libuv 双发）
function New-UnicodeKeys([string]$text, [System.Collections.Generic.List[object]]$records) {
  foreach ($c in [char[]]$text) {
    $down = New-Object WxWin+KEY_EVENT_RECORD
    $down.bKeyDown = $true; $down.wRepeatCount = 1; $down.wVirtualKeyCode = 0; $down.wVirtualScanCode = 0
    $down.UnicodeChar = $c; $down.dwControlKeyState = 0
    $up = New-Object WxWin+KEY_EVENT_RECORD
    $up.bKeyDown = $false; $up.wRepeatCount = 1; $up.wVirtualKeyCode = 0; $up.wVirtualScanCode = 0
    $up.UnicodeChar = [char]0; $up.dwControlKeyState = 0
    $r1 = New-Object WxWin+INPUT_RECORD; $r1.EventType = 1; $r1.KeyEvent = $down; $records.Add($r1)
    $r2 = New-Object WxWin+INPUT_RECORD; $r2.EventType = 1; $r2.KeyEvent = $up; $records.Add($r2)
  }
}

# Enter 键事件（UnicodeChar=\r——真实 console 投递格式）
function New-EnterKeys([System.Collections.Generic.List[object]]$records) {
  $down = New-Object WxWin+KEY_EVENT_RECORD
  $down.bKeyDown = $true; $down.wRepeatCount = 1; $down.wVirtualKeyCode = 0x0D; $down.wVirtualScanCode = 0x1C; $down.UnicodeChar = [char]13; $down.dwControlKeyState = 0
  $up = New-Object WxWin+KEY_EVENT_RECORD
  $up.bKeyDown = $false; $up.wRepeatCount = 1; $up.wVirtualKeyCode = 0x0D; $up.wVirtualScanCode = 0x1C; $up.UnicodeChar = [char]0; $up.dwControlKeyState = 0
  $r1 = New-Object WxWin+INPUT_RECORD; $r1.EventType = 1; $r1.KeyEvent = $down; $records.Add($r1)
  $r2 = New-Object WxWin+INPUT_RECORD; $r2.EventType = 1; $r2.KeyEvent = $up; $records.Add($r2)
}

# 清理残留 TUI（node dist\cli\index.js 进程 + 其 conhost 僵尸窗口——僵尸窗会顶掉窗口定位）
function Clear-StaleTui {
  $stale = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist.cli.index' }
  foreach ($s in $stale) {
    Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $s.ProcessId } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 400
}

# 起真实 TUI 窗口（Normal 可见）并定位其 console 窗口（MainWindowHandle 主通道 rect>0 校验，
# conhost 父子关系枚举兜底取面积最大者）
function Start-TuiWindow([string]$root) {
  $proc = Start-Process node -ArgumentList 'dist\cli\index.js' -WorkingDirectory $root -PassThru -WindowStyle Normal
  $hwnd = [IntPtr]::Zero
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 500
    try { $proc.Refresh() } catch {}
    $mh = $proc.MainWindowHandle
    if ($mh -ne [IntPtr]::Zero) {
      $l = 0; $t = 0; $w = 0; $h = 0
      [WxWin]::GetRectVals($mh, [ref]$l, [ref]$t, [ref]$w, [ref]$h)
      if ($w -gt 400 -and $h -gt 200) { $hwnd = $mh; break }
    }
    $conhost = Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $proc.Id } | Select-Object -First 1
    if ($conhost) {
      $script:hwnd = [IntPtr]::Zero
      $script:bestArea = 0
      $cb = [WxWin+EnumProc]{ param($h, $l)
        $p = 0; [void][WxWin]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq $conhost.ProcessId -or $p -eq $proc.Id) {
          $r2 = New-Object WxWin+RECT
          if ([WxWin]::GetWindowRect($h, [ref]$r2)) {
            $area = ($r2.Right - $r2.Left) * ($r2.Bottom - $r2.Top)
            if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:hwnd = $h }
          }
        }
        return $true
      }
      [void][WxWin]::EnumWindows($cb, [IntPtr]::Zero)
      if ($hwnd -ne [IntPtr]::Zero) { break }
    }
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw 'TUI window not found' }
  return @{ proc = $proc; hwnd = $hwnd }
}
