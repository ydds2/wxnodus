// src/kernel/voice.ts — 语音模式（本地 whisper：完全离线，音频不出机）
// 链路：ffmpeg（dshow 采集麦克风 → wav）→ whisper.cpp（本地转写 → 文本）
//        → TTS（Windows SAPI PowerShell 朗读，可选）
// 配置（开放兼容，settings.voice 或 env 覆盖）：
//   whisperBin:  whisper-cli 可执行（默认 PATH 里找 whisper-cli / main）
//   modelPath:   ggml 模型文件（默认 <dataDir>/voice/models/ggml-*.bin 自动发现）
//   device:      ffmpeg dshow 采集设备名（默认自动枚举第一个音频设备）
//   WXNODUS_VOICE_* env 同名覆盖；缺失组件时 checkVoice 给出明确指引（不假装可用）
// A20：vad 模式——ffmpeg 输出裸 PCM 到管道，Node 侧自研能量检测（见 vad.ts），
//      静音达阈值自动停止（免提闭环：说话→静音→自动转写→提交）。
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DEFAULT_VAD, VadTracker, pcmToInt16, type VadConfig } from './vad.js';

export interface VoiceConfig {
  whisperBin: string | null;
  modelPath: string | null;
  device: string | null;
}

export function resolveVoiceConfig(settings: Record<string, any> | undefined, dataDir: string, env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const v = (settings?.voice ?? {}) as Record<string, any>;
  const modelFromEnv = env.WXNODUS_VOICE_MODEL?.trim() || null;
  // 模型自动发现：<dataDir>/voice/models/ggml-*.bin
  let modelPath = v.modelPath ?? modelFromEnv ?? null;
  if (!modelPath) {
    try {
      const modelsDir = join(dataDir, 'voice', 'models');
      if (existsSync(modelsDir)) {
        const found = readdirSync(modelsDir).find(f => f.endsWith('.bin'));
        if (found) modelPath = join(modelsDir, found);
      }
    } catch { /* 忽略 */ }
  }
  return {
    whisperBin: (v.whisperBin ?? env.WXNODUS_VOICE_BIN?.trim()) || null,
    modelPath,
    device: (v.device ?? env.WXNODUS_VOICE_DEVICE?.trim()) || null,
  };
}

function isWindows(platform = process.platform): boolean {
  return platform === 'win32';
}

/** whisper 可执行探测：配置路径 → PATH 里的 whisper-cli / main */
function findWhisperBin(cfg: VoiceConfig): string | null {
  if (cfg.whisperBin && existsSync(cfg.whisperBin)) return cfg.whisperBin;
  for (const name of ['whisper-cli', 'main']) {
    try {
      const r = spawnSync(isWindows() ? 'where' : 'which', [name], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0]!;
    } catch { /* 继续探测 */ }
  }
  return null;
}

function hasFfmpeg(): boolean {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe', timeout: 10000 });
    return r.status === 0;
  } catch { return false; }
}

export interface VoiceCheck {
  sttAvailable: boolean;
  details: string[];
}

/** 就绪检查（/voice status 与 toggle 共用——缺失组件给明确指引，不假装可用） */
export function checkVoice(settings: Record<string, any> | undefined, dataDir: string): VoiceCheck {
  const cfg = resolveVoiceConfig(settings, dataDir);
  const details: string[] = [];
  const ff = hasFfmpeg();
  if (!ff) details.push('STT provider: MISSING — 缺少 ffmpeg（采集麦克风），请安装并加入 PATH');
  else details.push('STT provider: ffmpeg（采集）就绪');
  const bin = findWhisperBin(cfg);
  if (!bin) {
    details.push('Whisper: MISSING — 未找到 whisper-cli（whisper.cpp），请安装或设置 WXNODUS_VOICE_BIN');
  } else {
    details.push(`Whisper: ${bin}（本地转写）`);
  }
  if (!cfg.modelPath) details.push('Whisper 模型: MISSING — 请放置 ggml-*.bin 到 data/voice/models/ 或设置 WXNODUS_VOICE_MODEL');
  else details.push(`Whisper 模型: ${cfg.modelPath}`);
  if (!cfg.device) {
    if (isWindows()) details.push('录音设备: 自动枚举（ffmpeg dshow 第一个音频设备；WXNODUS_VOICE_DEVICE 可指定）');
    else details.push('录音设备: 自动检测（非 Windows 需 WXNODUS_VOICE_DEVICE 指定 PulseAudio 源）');
  } else {
    details.push(`录音设备: ${cfg.device}`);
  }
  return { sttAvailable: ff && Boolean(bin) && Boolean(cfg.modelPath), details };
}

/** 枚举 Windows dshow 第一个音频设备（真实检测，非占位） */
export function detectAudioDevice(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WXNODUS_VOICE_DEVICE?.trim()) return env.WXNODUS_VOICE_DEVICE.trim();
  if (!isWindows()) return null;
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      stdio: 'pipe', timeout: 15000, encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    // 行格式：[dshow @ ...]  "麦克风 (Realtek Audio)" (audio)
    const audioRe = /"\s*([^"]+?)\s*"\s*\(audio\)/g;
    let m: RegExpExecArray | null;
    while ((m = audioRe.exec(out)) !== null) {
      const name = m[1]!.trim();
      if (name && !/virtual|speakers|扬声器|立体声混音/i.test(name)) return name;
    }
    // 回退：无候选时返回第一个 (audio) 设备名（纯扬声器环境也能录系统音频）
    const anyRe = /"s*([^"]+?)s*"s*(audio)/;
    const any = out.match(anyRe);
    return any ? any[1]!.trim() || null : null;
  } catch { return null; }
}

// ── 录音会话（start → ffmpeg 后台采集 → stop → 转写）────────
export interface RecordingSession {
  proc: ReturnType<typeof spawn>;
  wavPath: string;
  startedAt: number;
  /** A20：VAD 模式——Node 侧 wav 写入器（ffmpeg 走 PCM 管道） */
  wav?: WavWriter;
  /** A20：VAD 自动停止回调（gateway 注册：停止+转写+提交） */
  onVadEnded?: () => void;
}

/** 自研 WAV 写入器：Node 侧写 44 字节 RIFF header + PCM 数据，结束回填 size。 */
export class WavWriter {
  private fd: number;
  private bytes = 0;
  private closed = false;

  constructor(path: string, sampleRate: number, channels = 1) {
    this.fd = openSync(path, 'w');
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * channels * 2, 28);
    h.writeUInt16LE(channels * 2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(0, 40);
    writeSync(this.fd, h, 0, 44, 0);
  }

  write(buf: Buffer): void {
    if (this.closed) return;
    writeSync(this.fd, buf);
    this.bytes += buf.length;
  }

  /** 回填 header 大小字段并关闭（幂等）。 */
  finalize(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const size = Buffer.alloc(8);
      size.writeUInt32LE(36 + this.bytes, 0);
      size.writeUInt32LE(this.bytes, 4);
      writeSync(this.fd, size, 0, 8, 4);
      writeSync(this.fd, size, 0, 4, 40);
    } catch { /* 忽略 */ }
    try { closeSync(this.fd); } catch { /* 忽略 */ }
  }
}

export interface StartRecordingOptions {
  /** A20：VAD 模式（免提）——静音自动停止，需配 onVadEnded */
  vad?: boolean;
  /** VAD 自动停止后的回调（停止+转写+提交由 gateway 实现） */
  onVadEnded?: () => void;
  /** VAD 参数覆盖（静音时长等） */
  vadConfig?: VadConfig;
}

export function startRecording(
  dataDir: string,
  settings: Record<string, any> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts: StartRecordingOptions = {},
): { ok: true; rec: RecordingSession } | { ok: false; error: string } {
  const cfg = resolveVoiceConfig(settings, dataDir, env);
  if (!hasFfmpeg()) return { ok: false, error: '缺少 ffmpeg——请安装并加入 PATH（麦克风采集依赖）' };
  const device = cfg.device || detectAudioDevice(env);
  if (isWindows() && !device) return { ok: false, error: '未找到录音设备——设置 WXNODUS_VOICE_DEVICE 指定麦克风设备名' };
  try {
    const voiceDir = join(dataDir, 'voice');
    mkdirSync(voiceDir, { recursive: true });
    const wavPath = join(voiceDir, `rec-${Date.now()}-${randomUUID().slice(0, 6)}.wav`);
    const vad = opts.vad;
    // 采集源：Windows dshow（自动/指定设备）；其余 PulseAudio 默认源
    const inputArgs = isWindows()
      ? ['-f', 'dshow', '-i', `audio=${device}`]
      : ['-f', 'pulse', '-i', 'default'];
    // VAD 模式：裸 PCM 走管道，Node 写 wav + 能量检测；否则 ffmpeg 直写 wav
    const args = vad
      ? [...inputArgs, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']
      : [...inputArgs, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath];
    const proc = spawn('ffmpeg', args, { stdio: vad ? ['ignore', 'pipe', 'ignore'] : 'ignore' });
    proc.on('error', () => { /* 采集进程错误由 stop 时检测 */ });
    const rec: RecordingSession = { proc, wavPath, startedAt: Date.now(), onVadEnded: opts.onVadEnded };

    if (vad) {
      const writer = new WavWriter(wavPath, 16000);
      rec.wav = writer;
      const tracker = new VadTracker(opts.vadConfig ?? DEFAULT_VAD);
      // ffmpeg dshow 无静音压缩——块流按到达顺序喂检测器
      proc.stdout!.on('data', (chunk: Buffer) => {
        writer.write(chunk);
        const r = tracker.feed(pcmToInt16(chunk));

        if (r.speechEnded) {
          // 自动停止：结束采集 + 落盘 + 通知 gateway（停止+转写+提交）
          stopRecordingProcess(proc);
          writer.finalize();
          rec.onVadEnded?.();
        }
      });
    }

    return { ok: true, rec };
  } catch (e: any) {
    return { ok: false, error: `采集启动失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** 结束 ffmpeg 采集进程（Windows taskkill / 其余 SIGTERM）。 */
function stopRecordingProcess(proc: ReturnType<typeof spawn>): void {
  try {
    if (isWindows()) {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', timeout: 5000 });
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* 忽略 */ }
}

/** 停止采集并本地转写（whisper.cpp）；返回文本或错误 */
export async function stopAndTranscribe(rec: RecordingSession, dataDir: string, settings: Record<string, any> | undefined, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; text: string; ms: number } | { ok: false; error: string }> {
  const t0 = Date.now();
  try {
    // 结束采集：ffmpeg 需要 SIGTERM（Windows taskkill）才能写完 wav 尾部
    stopRecordingProcess(rec.proc);
    // VAD 模式 wav 由 Node 写（已 finalize 或在此补）；ffmpeg 直写模式需等落盘
    if (rec.wav) {
      rec.wav.finalize();
    } else {
      await new Promise(r => setTimeout(r, 600));
    }
    if (!existsSync(rec.wavPath)) return { ok: false, error: '录音文件未生成（麦克风无输入？）' };
    const cfg = resolveVoiceConfig(settings, dataDir, env);
    const bin = findWhisperBin(cfg);
    if (!bin) return { ok: false, error: '未找到 whisper-cli（whisper.cpp）——安装后设置 WXNODUS_VOICE_BIN' };
    if (!cfg.modelPath) return { ok: false, error: '缺少 whisper 模型——放置 ggml-*.bin 到 data/voice/models/' };
    const outBase = rec.wavPath.replace(/\.wav$/, '');
    const r = spawnSync(bin, ['-m', cfg.modelPath, '-f', rec.wavPath, '-otxt', '-of', outBase, '-np'], {
      stdio: 'pipe', timeout: 120000, encoding: 'utf8',
    });
    if (r.status !== 0) {
      return { ok: false, error: `转写失败（whisper 退出码 ${r.status ?? '?'}）：${String(r.stderr ?? '').slice(0, 120)}` };
    }
    // whisper.cpp 输出 <outBase>.txt
    const textFile = `${outBase}.txt`;
    const text = existsSync(textFile) ? readFileText(textFile) : '';
    return { ok: true, text: text.trim(), ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: `转写异常：${String(e?.message ?? e).slice(0, 120)}` };
  }
}

function readFileText(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch { return ''; }
}

// ── TTS（Windows SAPI 本地朗读，零依赖；非 Windows 不可用）──
// A20：异步 + 串行队列——新播报打断旧的（清队列 + kill 当前进程）。
let ttsQueue: string[] = [];
let ttsProc: ReturnType<typeof spawn> | null = null;
let ttsRunning = false;

function sanitizeTts(text: string): string {
  return String(text ?? '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！？、；：""''（）\s,.!?;:()\-+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function speakOnce(text: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise(resolve => {
    const ps = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    ttsProc = child;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, 30000);
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      if (ttsProc === child) ttsProc = null;
      resolve(code === 0);
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (ttsProc === child) ttsProc = null;
      resolve(false);
    });
  });
}

async function pumpTts(env: NodeJS.ProcessEnv): Promise<void> {
  if (ttsRunning) return;
  ttsRunning = true;
  try {
    while (ttsQueue.length > 0) {
      const text = ttsQueue.shift()!;
      await speakOnce(text, env);
      // 被打断（新播报清空了队列）→ 停止；队列有新内容则继续
    }
  } finally {
    ttsRunning = false;
  }
}

/**
 * 播报文本（入队 + 打断旧播报）。返回 true 表示已入队（非 Windows 恒 false）。
 * 播报是附加能力——失败静默，绝不阻塞主流程。
 */
export function speakTts(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isWindows()) return false;
  const safe = sanitizeTts(text);
  if (!safe) return false;
  // 打断：清空旧队列 + kill 正在播报的进程（新播报立即生效）
  ttsQueue = [];
  if (ttsProc) {
    try { ttsProc.kill(); } catch { /* 忽略 */ }
    ttsProc = null;
  }
  ttsQueue.push(safe);
  void pumpTts(env);
  return true;
}
