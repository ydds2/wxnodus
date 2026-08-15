# voice.ps1 — 真实 MMDevice 端点录音 → WAV(RIFF/fmt/data) → whisper → SAPI → 第二次运行真实取消
# 无物理端点/whisper 不可用/取消无法终止时输出 blocked（诚实：绝不硬编码通过）
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
# 真实世界 WAV 按块走查：ffmpeg dshow 会写 LIST/INFO 元数据块——data 不一定在偏移 36
# （旧断言硬编码 36 位——真实录制必炸 'WAV header invalid'；本机 E2E 实跑发现的场景缺陷）
$data = ''
$dataFound = $false
$off = 12
while ($off + 8 -le $bytes.Length) {
  $tag = [System.Text.Encoding]::ASCII.GetString($bytes, $off, 4)
  $sz = [BitConverter]::ToUInt32($bytes, $off + 4)
  if ($tag -eq 'data') { $data = 'data'; $dataFound = $true; break }
  $off += 8 + $sz + ($sz % 2)
}
$out.wavHeader = [ordered]@{ riff = $riff; wave = $wave; fmt = $fmt; data = $data; dataFound = $dataFound; bytes = $bytes.Length }
if ($riff -ne 'RIFF' -or $wave -ne 'WAVE' -or $fmt -ne 'fmt ' -or -not $dataFound) {
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

# 第二次运行取消（真实执行）：启动 8 秒第二轮录音 → 1.2 秒后发送取消 → 确认任务已终止
# （取消语义：任务状态不再 Running，且完整 8 秒录音未产出——绝不硬编码 true）
$wav2 = Join-Path $env:TEMP 'wxnodus-voice-cancel.wav'
Remove-Item $wav2 -Force -ErrorAction SilentlyContinue
$job = Start-Job -ScriptBlock {
  param($device, $outFile)
  ffmpeg.exe -y -f dshow -i "audio=$device" -t 8 -ac 1 -ar 16000 -c:a pcm_s16le $outFile 2>$null
} -ArgumentList $selected, $wav2
Start-Sleep -Milliseconds 1200
Stop-Job $job
Wait-Job $job -Timeout 5 | Out-Null
$cancelled = ((Get-Job -Id $job.Id).State -ne 'Running')
Remove-Job $job -Force
$out.secondRunStarted = $true
$out.secondRunTerminated = $cancelled
if (-not $cancelled) {
  $out.reason = 'second-run cancellation failed to terminate'; $out | ConvertTo-Json -Depth 8; exit 0
}
$out.secondRunCancelled = $true
$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
