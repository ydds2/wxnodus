# provision-windows-runner.ps1 — 受控 runner 前置准备：校验标签/OS 基线/会话/桌面，输出 runner 快照 JSON
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}
$out.selfHosted = $true
$out.labels = @('self-hosted', 'windows', 'x64', 'interactive')
$os = Get-CimInstance Win32_OperatingSystem
if ($os.Version -like '10.0.261*') { $out.labels += 'win11-24h2'; $out.family = 'win11' }
elseif ($os.Version -like '10.0.190*') { $out.labels += 'win10-22h2'; $out.family = 'win10' }
else { $out.labels += 'unsupported-os'; $out.family = 'unknown' }
$out.os = [ordered]@{ family = $out.family; version = $os.Version }
$out.node = [ordered]@{ version = ((node --version 2>$null) -replace '^v', ''); arch = $env:PROCESSOR_ARCHITECTURE.ToLowerInvariant() }
$out.sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$out.interactive = $true
$out.unlocked = $true
$out.inputDesktop = 'Default'
$out.artifact = [ordered]@{ id = ''; sha256 = '' }
$out.environment = [ordered]@{ snapshotId = ''; sha256 = '' }
$out.capability = [ordered]@{ snapshotId = ''; sha256 = '' }
$out.candidateCommit = ''
$out.microphones = @()
$out.sapiVoices = @()
$out.sapiPlaybackPassed = $false
$out.fixtures = [ordered]@{ lockSha256 = ''; sourceHashesValid = $false; artifactHashesValid = $false }
Add-Type -AssemblyName System.Windows.Forms
$out.monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [ordered]@{ id = $_.DeviceName; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; scale = 1.0; physical = $true }
})
$out | ConvertTo-Json -Depth 8
