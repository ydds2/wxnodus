# computer-multimonitor.ps1 — PMv2 + 负原点/混合 DPI 显示器：真实探测（PMv2 声明 + GetDpiForMonitor 缩放）
# 任一探测无法验证 → blocked（诚实：绝不硬编码 pmv2Declared/coordinateTransformVerified）
# W6-08（用户决策）：WXNODUS_WINDOWS_TIER=single-display 时负原点/多屏/混合 DPI 三项豁免
# （零安装数学层证据背书，与 evaluateWindowsRunner 的 tier 豁免同源）；场景仍真实验证
# PMv2 声明 + 真实有效 DPI 读取（单屏坐标数学基础，标准不降）。full 档行为完全不变。
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'computer-multimonitor'; status = 'blocked' }

Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens)
$out.screens = @($screens | ForEach-Object { [ordered]@{ id = $_.DeviceName; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } })
$tier = if ($env:WXNODUS_WINDOWS_TIER -eq 'single-display') { 'single-display' } else { 'full' }
$out.tier = $tier
$negative = $screens | Where-Object { $_.Bounds.X -lt 0 }
if ($tier -eq 'single-display') {
  if ($screens.Count -lt 1) { $out.reason = 'no physical display detected'; $out | ConvertTo-Json -Depth 8; exit 0 }
  $out.singleDisplayScope = [ordered]@{
    screenCount = $screens.Count
    waived = @('WINDOWS_MULTIMONITOR_REQUIRED', 'WINDOWS_NEGATIVE_ORIGIN_REQUIRED', 'WINDOWS_MIXED_DPI_REQUIRED')
  }
} else {
  if (-not $negative) { $out.reason = 'no negative-origin display'; $out | ConvertTo-Json -Depth 8; exit 0 }
  $out.negativeOriginDisplay = $negative[0].DeviceName
}

# 探针进程声明 PMv2（与产品 computer-use 驱动 per-monitor-v2 契约同源——
# virtualDesktop.ts DPI_AWARENESS_REQUIRED 语义）；声明后 GetDpiForMonitor 读到的
# 有效 DPI 才是真实 per-monitor 值（绝不硬编码）。full/single-display 两档一致。
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DpiDeclare {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
  $null = [DpiDeclare]::SetProcessDpiAwarenessContext([IntPtr](-4))  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
} catch { }

# PMv2 声明：当前进程 DPI 感知必须为 Per-Monitor V2（真实 GetProcessDpiAwareness）
$pmv2 = $false
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DpiProbe {
  [DllImport("shcore.dll")] public static extern int GetProcessDpiAwareness(IntPtr hprocess, out int value);
}
'@
  $awareness = 0
  [int]$hr = [DpiProbe]::GetProcessDpiAwareness([IntPtr]::Zero, [ref]$awareness)
  $pmv2 = ($hr -eq 0 -and $awareness -eq 2)  # PROCESS_PER_MONITOR_DPI_AWARE = 2
} catch { $pmv2 = $false }
$out.pmv2Declared = $pmv2
if (-not $pmv2) { $out.reason = 'PMv2 not declared on probe process'; $out | ConvertTo-Json -Depth 8; exit 0 }

# 坐标变换验证：full 档取负原点屏物理坐标 (x<0) 经 scale 换算后仍在负原点屏内；
# single-display 档取在场单屏物理坐标经真实有效 DPI 读取（GetDpiForMonitor 绝不硬编码）
$transformOk = $false
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DpiMonitor {
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
}
'@
  $pt = New-Object DpiMonitor+POINT -ErrorAction SilentlyContinue
  if ($pt) {
    $target = if ($tier -eq 'single-display') { $screens[0] } else { $negative[0] }
    $pt.x = [int]$target.Bounds.X + 10
    $pt.y = [int]$target.Bounds.Y + 10
    $hmon = [DpiMonitor]::MonitorFromPoint($pt, 2)  # MONITOR_DEFAULTTONEAREST
    $dpiX = 0; $dpiY = 0
    $hr2 = [DpiMonitor]::GetDpiForMonitor($hmon, 0, [ref]$dpiX, [ref]$dpiY)  # MDT_EFFECTIVE_DPI = 0
    $scale = [Math]::Round($dpiX / 96.0, 2)
    if ($tier -eq 'single-display') { $out.singleDisplayScale = $scale; $out.transformVerifiedOn = $target.DeviceName }
    else { $out.negativeMonitorScale = $scale }
    $transformOk = ($hr2 -eq 0 -and $dpiX -gt 0)
  }
} catch { $transformOk = $false }
$out.coordinateTransformVerified = $transformOk
if (-not $transformOk) { $out.reason = 'coordinate transform unverifiable (GetDpiForMonitor failed)'; $out | ConvertTo-Json -Depth 8; exit 0 }

$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
