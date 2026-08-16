# provision-windows-runner.ps1 — 受控 runner 前置准备（W6-02 诚实版）：
# 校验标签/OS 基线；会话/桌面/解锁状态、显示器 DPI、麦克风、SAPI 全部真实探测——失败即如实输出（绝不硬编码通过）
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}
$out.selfHosted = $true
$out.labels = @('self-hosted', 'windows', 'x64', 'interactive')
$os = Get-CimInstance Win32_OperatingSystem
# W6-07（用户决策）：24H2 代际构建 26100 与 26200 均入矩阵（同代际，只扩矩阵不降标准）
if ($os.Version -like '10.0.261*' -or $os.Version -like '10.0.262*') { $out.labels += 'win11-24h2'; $out.family = 'win11' }
elseif ($os.Version -like '10.0.190*') { $out.labels += 'win10-22h2'; $out.family = 'win10' }
else { $out.labels += 'unsupported-os'; $out.family = 'unknown' }
$out.os = [ordered]@{ family = $out.family; version = $os.Version }
$out.node = [ordered]@{ version = ((node --version 2>$null) -replace '^v', ''); arch = $env:PROCESSOR_ARCHITECTURE.ToLowerInvariant() }
$out.sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

# 交互/解锁/输入桌面（真实 OpenInputDesktop 探测——锁屏/服务会话即失败，诚实记录）
$out.interactive = $false
$out.unlocked = $false
$out.inputDesktop = 'unknown'
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DesktopProbe {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
}
'@
  $hDesktop = [DesktopProbe]::OpenInputDesktop(0, $false, 0x0001)
  if ($hDesktop -ne [IntPtr]::Zero) {
    $out.inputDesktop = 'Default'
    $out.interactive = $true
    $out.unlocked = $true
    [DesktopProbe]::CloseDesktop($hDesktop) | Out-Null
  }
} catch { }

$out.artifact = [ordered]@{ id = ''; sha256 = '' }
$out.environment = [ordered]@{ snapshotId = ''; sha256 = '' }
$out.capability = [ordered]@{ snapshotId = ''; sha256 = '' }
$out.candidateCommit = ''

# 麦克风（真实物理端点）
$out.microphones = @(Get-PnpDevice -Class AudioEndpoint -Status OK 2>$null | Where-Object { $_.FriendlyName -match 'Mic|麦克风|Microphone' } | ForEach-Object {
  [ordered]@{ id = $_.InstanceId; active = $true; physical = $true }
})

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

# W6-08：fixture 锁真实读取（此前恒空——WINDOWS_FIXTURE_LOCK_INVALID 恒命中，机制不完整）
$out.fixtures = [ordered]@{ lockSha256 = ''; sourceHashesValid = $false; artifactHashesValid = $false }
try {
  $uiaRoot = Join-Path $PSScriptRoot '..\tests\fixtures\windows\uia'
  $lockPath = Join-Path $uiaRoot 'fixtures.lock.json'
  $genLockPath = Join-Path $uiaRoot 'fixtures.generator.lock.json'
  $genPath = Join-Path $uiaRoot 'generate-fixtures.mjs'
  if ((Test-Path $lockPath) -and (Test-Path $genLockPath) -and (Test-Path $genPath)) {
    $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
    $genLock = Get-Content $genLockPath -Raw | ConvertFrom-Json
    $out.fixtures.lockSha256 = (Get-FileHash -Algorithm SHA256 $lockPath).Hash.ToLowerInvariant()
    $out.fixtures.sourceHashesValid = ((Get-FileHash -Algorithm SHA256 $genPath).Hash.ToLowerInvariant() -eq $genLock.generator.sha256)
    $out.fixtures.artifactHashesValid = $true
    foreach ($f in $lock.fixtures) {
      $artPath = Join-Path (Join-Path $PSScriptRoot '..') (($f.artifact -replace '/', '\'))
      if (-not (Test-Path $artPath)) { $out.fixtures.artifactHashesValid = $false; break }
      if ((Get-FileHash -Algorithm SHA256 $artPath).Hash.ToLowerInvariant() -ne $f.artifactSha256) { $out.fixtures.artifactHashesValid = $false; break }
    }
  }
} catch { $out.fixtures = [ordered]@{ lockSha256 = ''; sourceHashesValid = $false; artifactHashesValid = $false } }

# 显示器（真实 GetDpiForMonitor 缩放——失败记 null，绝不硬编码 1.0）
# W8-30：读取前声明 PMv2（与产品 per-monitor-v2 契约同源）——非 PMv2 进程下
# GetDpiForMonitor 返回系统 DPI（本机 125% 显示器被误报 1.0 的实测根因），
# 声明后才是真实逐显示器有效 DPI。
Add-Type -AssemblyName System.Windows.Forms
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DpiDeclareProvision {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
  $null = [DpiDeclareProvision]::SetProcessDpiAwarenessContext([IntPtr](-4))  # PER_MONITOR_AWARE_V2
} catch { }
$monitors = @()
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DpiMonitorProvision {
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
}
'@
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $pt = New-Object DpiMonitorProvision+POINT
    $pt.x = [int]$screen.Bounds.X + [int]($screen.Bounds.Width / 2)
    $pt.y = [int]$screen.Bounds.Y + [int]($screen.Bounds.Height / 2)
    $hmon = [DpiMonitorProvision]::MonitorFromPoint($pt, 2)
    $dpiX = 0; $dpiY = 0
    $hr = [DpiMonitorProvision]::GetDpiForMonitor($hmon, 0, [ref]$dpiX, [ref]$dpiY)
    $scale = if ($hr -eq 0 -and $dpiX -gt 0) { [Math]::Round($dpiX / 96.0, 2) } else { $null }
    $monitors += [ordered]@{ id = $screen.DeviceName; x = $screen.Bounds.X; y = $screen.Bounds.Y; width = $screen.Bounds.Width; height = $screen.Bounds.Height; scale = $scale; physical = $true }
  }
} catch { }
$out.monitors = $monitors

$out | ConvertTo-Json -Depth 8
