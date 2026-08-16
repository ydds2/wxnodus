# preflight.ps1 — 受控 runner 前置探测：会话/桌面/OS/Node/显示器（真实 DPI）/麦克风/SAPI（真实探测，缺失即 blocked）
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}
$out.scenarioId = 'preflight'
$probeFailures = @()

# 会话（真实）
$out.sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

# 输入桌面与解锁状态（真实探测：OpenInputDesktop('Default') 成功即 interactive+unlocked，失败即诚实记录）
$out.inputDesktop = 'unknown'
$out.interactive = $false
$out.unlocked = $false
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DesktopProbe {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
}
'@
  $hDesktop = [DesktopProbe]::OpenInputDesktop(0, $false, 0x0001)  # DESKTOP_READOBJECTS
  if ($hDesktop -ne [IntPtr]::Zero) {
    $out.inputDesktop = 'Default'
    $out.interactive = $true
    $out.unlocked = $true  # 锁屏时 OpenInputDesktop 对默认桌面失败
    [DesktopProbe]::CloseDesktop($hDesktop) | Out-Null
  } else {
    $probeFailures += 'interactive desktop unavailable (locked or non-interactive session)'
  }
} catch { $probeFailures += 'desktop probe failed' }

# OS / Node（真实）
$os = Get-CimInstance Win32_OperatingSystem
$out.osVersion = $os.Version
# W6-07：26200 与 26100 同代际入矩阵（此前 26200 被判 unknown）
$out.osFamily = if ($os.Version -like '10.0.26[12]*') { 'win11' } elseif ($os.Version -like '10.0.190*') { 'win10' } else { 'unknown' }
$out.nodeVersion = (node --version 2>$null) -replace '^v', ''

# 显示器（真实 GetDpiForMonitor 缩放——失败记 null 并诚实 blocked，绝不硬编码 1.0）
# W8-30：读取前声明 PMv2（与产品 per-monitor-v2 契约同源）——非 PMv2 进程下读到的
# 是系统 DPI 虚拟化值（本机 125% 显示器误报 1.0 的实测根因），声明后才是真实值
Add-Type -AssemblyName System.Windows.Forms
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DpiDeclarePreflight {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
  $null = [DpiDeclarePreflight]::SetProcessDpiAwarenessContext([IntPtr](-4))  # PER_MONITOR_AWARE_V2
} catch { }
$monitors = @()
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DpiMonitorProbe {
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
}
'@
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $pt = New-Object DpiMonitorProbe+POINT
    $pt.x = [int]$screen.Bounds.X + [int]($screen.Bounds.Width / 2)
    $pt.y = [int]$screen.Bounds.Y + [int]($screen.Bounds.Height / 2)
    $hmon = [DpiMonitorProbe]::MonitorFromPoint($pt, 2)
    $dpiX = 0; $dpiY = 0
    $hr = [DpiMonitorProbe]::GetDpiForMonitor($hmon, 0, [ref]$dpiX, [ref]$dpiY)
    $scale = if ($hr -eq 0 -and $dpiX -gt 0) { [Math]::Round($dpiX / 96.0, 2) } else { $null }
    if ($null -eq $scale) { $probeFailures += "monitor $($screen.DeviceName) DPI unverifiable" }
    $monitors += [ordered]@{ id = $screen.DeviceName; x = $screen.Bounds.X; y = $screen.Bounds.Y; width = $screen.Bounds.Width; height = $screen.Bounds.Height; scale = $scale; physical = $true }
  }
} catch { $probeFailures += 'monitor DPI probe failed' }
$out.monitors = $monitors

# 麦克风（真实物理端点）
$mics = @(Get-PnpDevice -Class AudioEndpoint -Status OK 2>$null | Where-Object { $_.FriendlyName -match 'Mic|麦克风|Microphone' } | ForEach-Object {
  [ordered]@{ id = $_.InstanceId; active = $true; physical = $true }
})
$out.microphones = $mics

# SAPI 语音与播放探针（真实）
$sapi = @()
$playback = $false
try {
  Add-Type -AssemblyName System.Speech
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $sapi = @($voice.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
  $playback = $sapi.Count -gt 0
  $voice.Dispose()
} catch { }
$out.sapiVoices = $sapi
$out.sapiPlaybackPassed = $playback

# 诚实结论：任一探针失败 → blocked（绝不伪造 passed）
if ($probeFailures.Count -gt 0) {
  $out.status = 'blocked'
  $out.probeFailures = $probeFailures
} else {
  $out.status = 'passed'
}
$out | ConvertTo-Json -Depth 8
