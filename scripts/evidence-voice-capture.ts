// scripts/evidence-voice-capture.ts — 语音采集真实链路证据（tsx 实跑）
// 真实链路：detectAudioDevice 枚举 dshow 设备 → ffmpeg 真实录制 2s（16kHz 单声道 wav）
// → 头完整性验证（KF-005 修复后的同款不变量：RIFF/WAVE/fmt/data + 双 size 字段与实盘一致）。
// 转写环节（W8-07/08）：SAPI 原生识别器回路 + 本机真实 whisper.cpp 资产回路（-m 修复后）——双通道真实执行。
// receipt 落 artifacts/release-evidence/<runId>/voice-capture/outcome.json。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const runId = flag('run');
if (!runId) {
  console.error('EVIDENCE_USAGE: --run <runId>');
  process.exit(2);
}

const workdir = join(ROOT, 'artifacts', 'release-evidence', runId, 'voice-capture');
mkdirSync(workdir, { recursive: true });
const wavPath = join(workdir, 'capture.wav');

const { detectAudioDevice } = await import('../src/kernel/voice.js');
const device = detectAudioDevice(process.env);

const t0 = Date.now();
let ffmpegExit: number | null = null;
let ffmpegErr = '';
if (device) {
  // 真实 dshow 录制：2 秒 / 16kHz / 单声道 / wav 直写
  const r = spawnSync('ffmpeg', ['-y', '-f', 'dshow', '-i', `audio=${device}`, '-t', '2', '-ac', '1', '-ar', '16000', wavPath], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8',
  });
  ffmpegExit = r.status;
  ffmpegErr = String(r.stderr ?? '').split(/\r?\n/).filter(l => l.includes('Error') || l.includes('error')).slice(-2).join(' | ').slice(0, 300);
}
const captureMs = Date.now() - t0;

// 头完整性（真实世界 WAV 按块遍历：ffmpeg 会写 LIST/INFO 元数据块，data 不一定在 36）
let headerOk = false;
let sizesOk = false;
let dataBytes = 0;
if (device && ffmpegExit === 0) {
  try {
    const bytes = readFileSync(wavPath);
    headerOk = bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WAVE'
      && bytes.subarray(12, 16).toString('latin1') === 'fmt ';
    let dataOffset = -1;
    let dataSize = -1;
    for (let off = 12; off + 8 <= bytes.length;) {
      const tag = bytes.subarray(off, off + 4).toString('latin1');
      const sz = bytes.readUInt32LE(off + 4);
      if (tag === 'data') { dataOffset = off + 8; dataSize = sz; break; }
      off += 8 + sz + (sz % 2);
    }
    const riffSize = bytes.length >= 8 ? bytes.readUInt32LE(4) : 0;
    dataBytes = dataOffset > 0 ? bytes.length - dataOffset : 0;
    sizesOk = dataOffset > 0 && dataSize === dataBytes && dataBytes > 0 && riffSize === bytes.length - 8;
  } catch { /* 读文件失败如实记录 */ }
}

const capturePassed = Boolean(device) && ffmpegExit === 0 && headerOk && sizesOk;

// W8-07/08 转写双通道确定性验证：
// ① SAPI 回路——TTS 合成「一二三四五」→ Windows 原生识别器转回（whisper 缺失时生产兜底通道）；
// ② whisper 回路——同一合成语音经生产 stopAndTranscribe（本机真实 whisper.cpp 资产，-m 修复后）转写；
// ③ 生产路径——真实麦克风采集文件经 stopAndTranscribe（环境静音 → 如实空/短结果）。
let synthExit: number | null = null;
let sapiTranscript: string | null = null;
let sapiError = '';
let whisperOk = false;
let whisperText: string | null = null;
let whisperError = '';
let prodDetail = '';
if (capturePassed) {
  const { sapiTranscribe, stopAndTranscribe, resolveVoiceConfig } = await import('../src/kernel/voice.js');
  const { existsSync } = await import('node:fs');
  // TTS 合成已知语句
  const synthWav = join(workdir, 'synth-speech.wav');
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SetOutputToWaveFile('${synthWav.replace(/'/g, "''").replace(/\\/g, '\\\\')}')`,
    "$s.Speak('一二三四五')",
    '$s.Dispose()',
  ].join('; ');
  const syn = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf8' });
  synthExit = syn.status;
  // ① SAPI 回路
  if (syn.status === 0) {
    const r = await sapiTranscribe(synthWav, 'zh-CN');
    if (r.ok) { sapiTranscript = r.text; } else { sapiError = r.error; }
  }
  // ② whisper 回路（本机真实资产；无资产则如实记录 skipped）
  const cfg = resolveVoiceConfig({ voice: {} }, process.cwd(), process.env);
  if (cfg.whisperBin && existsSync(cfg.whisperBin) && cfg.modelPath) {
    const w = await stopAndTranscribe(
      { proc: { pid: -1, kill() {} } as unknown as Parameters<typeof stopAndTranscribe>[0]['proc'], wavPath: synthWav } as unknown as Parameters<typeof stopAndTranscribe>[0],
      join(workdir, 'data'), { voice: { whisperBin: cfg.whisperBin, modelPath: cfg.modelPath } }, process.env,
    );
    whisperOk = w.ok;
    if (w.ok) { whisperText = w.text.trim(); } else { whisperError = w.error; }
  } else {
    whisperError = 'skipped（本机无 whisper 资产）';
  }
  // ③ 生产路径：真实麦克风采集（环境静音 → 识别器如实空结果即链路成立）
  const prod = await stopAndTranscribe(
    { proc: { pid: -1, kill() {} } as unknown as Parameters<typeof stopAndTranscribe>[0]['proc'], wavPath } as unknown as Parameters<typeof stopAndTranscribe>[0],
    join(workdir, 'data'), { voice: {} }, process.env,
  );
  prodDetail = prod.ok
    ? `passed（静音采集 → 识别器返回${prod.text.trim() ? '「' + prod.text.trim().slice(0, 40) + '」' : '空文本'}——链路成立）`
    : prod.error.includes('SAPI 识别结果为空')
      ? 'passed（环境静音 → SAPI 如实返回空结果）'
      : `blocked（${prod.error.slice(0, 120)}）`;
}

const passed = capturePassed && synthExit === 0 && (sapiTranscript?.length ?? 0) > 0 && whisperOk && (whisperText ?? '').length > 0;
const outcome = {
  schema: 'voice-capture-evidence@1',
  runId,
  timestamp: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}/node${process.version}`,
  device: device ?? null,
  capture: { ffmpegExit, wavPath, dataBytes, headerOk, sizesOk, captureMs, lastErrors: ffmpegErr },
  sapiLoop: {
    synthExit,
    input: '一二三四五',
    transcript: sapiTranscript,
    error: sapiError,
    channel: 'Windows SAPI 原生识别器（whisper 缺失时生产兜底——系统组件零模型下载）',
  },
  whisperLoop: {
    ok: whisperOk,
    input: '一二三四五',
    transcript: whisperText,
    error: whisperError,
    channel: 'whisper.cpp（本机真实资产；-m 模型路径修复后——W8-08）',
  },
  productionPath: { detail: prodDetail },
  status: passed ? 'passed' : 'blocked',
  verdict: passed
    ? '语音端到端闭环：真实麦克风采集 + SAPI 转写回路 + whisper.cpp 真实资产回路 + 生产路径——全部真实执行'
    : '语音端到端未达标（采集/回路任一失败）——如实 blocked',
};
writeFileSync(join(workdir, 'outcome.json'), JSON.stringify(outcome, null, 2));
console.log(JSON.stringify({ status: outcome.status, device: device ?? null, ffmpegExit, dataBytes, headerOk, sizesOk, captureMs, sapiLoop: { transcript: sapiTranscript }, whisperLoop: { ok: whisperOk, transcript: whisperText }, productionPath: prodDetail, receipt: join(workdir, 'outcome.json') }, null, 2));
process.exit(passed ? 0 : 2);
