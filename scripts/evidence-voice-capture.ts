// scripts/evidence-voice-capture.ts — 语音采集真实链路证据（tsx 实跑）
// 真实链路：detectAudioDevice 枚举 dshow 设备 → ffmpeg 真实录制 2s（16kHz 单声道 wav）
// → 头完整性验证（KF-005 修复后的同款不变量：RIFF/WAVE/fmt/data + 双 size 字段与实盘一致）。
// 转写环节：whisper-cli 未安装 + 离线模型资产按用户指示放弃——如实 blocked，绝不伪造转写文本。
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
const outcome = {
  schema: 'voice-capture-evidence@1',
  runId,
  timestamp: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}/node${process.version}`,
  device: device ?? null,
  capture: { ffmpegExit, wavPath, dataBytes, headerOk, sizesOk, captureMs, lastErrors: ffmpegErr },
  transcribe: {
    status: 'blocked',
    reason: 'whisper-cli 未安装；离线模型资产按用户指示放弃——不伪造转写文本（链路本身已由 KF-006 回归锁定零同步 spawn）',
  },
  status: capturePassed ? 'passed' : 'blocked',
  verdict: capturePassed
    ? '语音采集真实链路成立：真实麦克风 → ffmpeg dshow 录制 → WAV 头完整（KF-005 修复后同款不变量）；转写环节按指示保持诚实 blocked'
    : '语音采集未达标（无设备/ffmpeg 失败/头校验失败）——如实 blocked',
};
writeFileSync(join(workdir, 'outcome.json'), JSON.stringify(outcome, null, 2));
console.log(JSON.stringify({ status: outcome.status, device: device ?? null, ffmpegExit, dataBytes, headerOk, sizesOk, captureMs, transcribe: outcome.transcribe.status, receipt: join(workdir, 'outcome.json') }, null, 2));
process.exit(capturePassed ? 0 : 2);
