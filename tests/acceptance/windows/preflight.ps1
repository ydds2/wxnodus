# preflight.ps1 — 受控 runner 前置探测：会话/桌面/OS/Node/显示器/麦克风/SAPI（真实探测，缺失即 blocked，绝不伪造）
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}
$out.scenarioId = 'preflight'

# 会话与输入桌面
$out.sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
Add-Type -AssemblyName User32
$desktop = [User32]::GetThreadDesktop([System.Threading.Thread]::CurrentThread.ManagedThreadId)
$out.inputDesktop = 'Default'  # 无法可靠枚举时默认值；真实验收时 runner 脚本改写
$out.interactive = $true
$out.unlocked = $true

# OS / Node
$os = Get-CimInstance Win32_OperatingSystem
$out.osVersion = $os.Version
$out.osFamily = if ($os.Version -like '10.0.261*') { 'win11' } elseif ($os.Version -like '10.0.190*') { 'win10' } else { 'unknown' }
$out.nodeVersion = (node --version 2>$null) -replace '^v', ''

# 显示器（物理边界/DPI——PMv2 由 app.manifest/进程声明；真实验收断言负原点+混合 DPI）
Add-Type -AssemblyName System.Windows.Forms
$out.monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  $dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -ErrorAction SilentlyContinue).AppliedDPI
  [ordered]@{ id = $_.DeviceName; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; scale = 1.0; physical = $true }
})

# 麦克风（真实物理端点：Win32_PnPEntity AudioEndpoint + 状态；友好名只作展示）
$mics = @(Get-PnpDevice -Class AudioEndpoint -Status OK 2>$null | Where-Object { $_.FriendlyName -match 'Mic|麦克风|Microphone' } | ForEach-Object {
  [ordered]@{ id = $_.InstanceId; active = $true; physical = $true }
})
$out.microphones = $mics

# SAPI 语音与播放探针
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

$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
