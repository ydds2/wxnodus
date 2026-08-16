# diag-windows.ps1 — 诊断：枚举所有可见顶层窗口（标题/类/PID/前台），并截屏存 evidence
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/diag-windows.ps1 [secondsToWait]
param([int]$WaitSeconds = 8)
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $ROOT 'artifacts\ime-evidence'
[void](New-Item -ItemType Directory -Force -Path $outDir)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinDiag {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
Start-Sleep -Seconds $WaitSeconds
$rows = @()
$fg = [WinDiag]::GetForegroundWindow()
$cb = [WinDiag+EnumWindowsProc]{ param($h, $l)
  if (-not [WinDiag]::IsWindowVisible($h)) { return $true }
  $t = New-Object System.Text.StringBuilder 256
  $c = New-Object System.Text.StringBuilder 256
  [void][WinDiag]::GetWindowText($h, $t, 256)
  [void][WinDiag]::GetClassName($h, $c, 256)
  $pid2 = 0; [void][WinDiag]::GetWindowThreadProcessId($h, [ref]$pid2)
  $r = New-Object WinDiag+RECT
  [void][WinDiag]::GetWindowRect($h, [ref]$r)
  $script:rows += [ordered]@{
    hwnd = ('0x{0:X}' -f $h.ToInt64()); title = $t.ToString(); cls = $c.ToString(); pid = $pid2;
    rect = ('{0},{1} {2}x{3}' -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top));
    foreground = ($h -eq $fg)
  }
  return $true
}
[void][WinDiag]::EnumWindows($cb, [IntPtr]::Zero)
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save((Join-Path $outDir 'diag-desktop.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[ordered]@{ kind = 'windows-diag'; foreground = ('0x{0:X}' -f $fg.ToInt64()); windows = $rows } | ConvertTo-Json -Depth 5
