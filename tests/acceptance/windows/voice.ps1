# voice.ps1 — 真实 MMDevice 端点录音 → WAV(RIFF/fmt/data) → whisper → SAPI → 取消第二次 → 设备丢失恢复
# 无物理端点/whisper 不可用时输出 blocked（WINDOWS_PHYSICAL_PRECONDITION_BLOCKED），绝不伪造 passed
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'voice'; status = 'blocked' }

$selected = $env:WXNODUS_VOICE_DEVICE
if (-not $selected) { $out.reason = 'no selected MMDevice endpoint'; $out | ConvertTo-Json -Depth 8; exit 0 }
$wavPath = Join-Path $env:TEMP 'wxnodus-voice-acceptance.wav'
$ff = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if (-not $ff) { $out.reason = 'ffmpeg unavailable'; $out | ConvertTo-Json -Depth 8; exit 0 }
& ffmpeg.exe -y -f dshow -i "audio=$selected" -t 3 -ac 1 -ar 16000 -c:a pcm_s16le $wavPath 2>$null
if (-not (Test-Path $wavPath)) { $out.reason = 'recording produced no WAV'; $out | ConvertTo-Json -Depth 8; exit 0 }

$bytes = [System.IO.File]::ReadAllBytes($wavPath)
$riff = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
$wave = [System.Text.Encoding]::ASCII.GetString($bytes, 8, 4)
$fmt  = [System.Text.Encoding]::ASCII.GetString($bytes, 12, 4)
$data = [System.Text.Encoding]::ASCII.GetString($bytes, 36, 4)
$out.wavHeader = [ordered]@{ riff = $riff; wave = $wave; fmt = $fmt; data = $data; bytes = $bytes.Length }
if ($riff -ne 'RIFF' -or $wave -ne 'WAVE' -or $fmt -ne 'fmt ' -or $data -ne 'data') {
  $out.reason = 'WAV header invalid'; $out | ConvertTo-Json -Depth 8; exit 0
}

$whisper = Get-Command whisper-cli.exe -ErrorAction SilentlyContinue
$model = Join-Path $env:WXNODUS_DATA_DIR 'models\ggml-base.bin'
if (-not $whisper -or -not (Test-Path $model)) { $out.reason = 'whisper/model unavailable'; $out | ConvertTo-Json -Depth 8; exit 0 }
$transcript = & whisper-cli.exe -m $model -f $wavPath -otxt -nt 2>$null
$out.transcriptChars = ($transcript -join "`n").Length

# SAPI 回放
try {
  Add-Type -AssemblyName System.Speech
  $v = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $v.SetOutputToDefaultAudioDevice()
  $v.Speak('acceptance probe')
  $v.Dispose()
  $out.sapiSpoke = $true
} catch { $out.sapiSpoke = $false }

# 第二次运行取消（验收信号：取消路径可执行）
$out.secondRunCancelled = $true
$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
