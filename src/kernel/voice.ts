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
import { mkdirSync, existsSync, readdirSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { DEFAULT_VAD, VadTracker, pcmToInt16, type VadConfig } from './vad.js';
// W3 Voice facade：转写执行/状态机/产物落盘委托 VoiceSessionService（唯一权威）——
// kernel 仅保留采集/设备枚举/TTS 等平台适配面（compatibility adapter）。
import { VoiceSessionService, type VoiceSessionDeps } from '../application/voice/voiceSessionService.js';
import type { TranscriptRef } from '../domain/voice/voiceSession.js';

export interface VoiceConfig {
  whisperBin: string | null;
  modelPath: string | null;
  device: string | null;
}

/**
 * CLI 安装目录的 data/voice（随包分发的组件——与运行时 dataDir 并列搜索）。
 * 根因修复：组件装在项目 data/voice/，但运行时 dataDir = cwd/data（用户从任意
 * 目录启动 CLI 时二者不同）——此前只搜 dataDir 导致「已安装却报 MISSING」。
 * 经 import.meta.url 从 dist/kernel/voice.js 回溯包根（dist/kernel → 包根 data/）。
 */
function installVoiceDir(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/kernel 或 dist/kernel → 上一级再上一级 = 包根
    const root = dirname(dirname(here));
    return join(root, 'data', 'voice');
  } catch { return null; }
}

function findModelsIn(dir: string): string | null {
  try {
    const modelsDir = join(dir, 'models');
    if (!existsSync(modelsDir)) return null;
    const found = readdirSync(modelsDir).find(f => f.endsWith('.bin'));
    return found ? join(modelsDir, found) : null;
  } catch { return null; }
}

function findCliIn(dir: string): string | null {
  try {
    for (const sub of ['Release', '.']) {
      const binDir = join(dir, 'bin', sub === '.' ? '' : sub);
      if (!existsSync(binDir)) continue;
      // V4 P5-4（C 级）：whisper.cpp 各版本产物名（whisper-cli.exe 新版/main.exe 旧版/
      // whisper.exe 别名）——此前仅精确匹配 whisper-cli.exe，编译产物名稍异即「未找到」
      const exe = readdirSync(binDir).find(f => /^(whisper-cli|main|whisper)(-[\w.]*)?\.exe$/i.test(f));
      if (exe) return join(binDir, exe);
    }
  } catch { /* 忽略 */ }
  return null;
}

export function resolveVoiceConfig(settings: Record<string, any> | undefined, dataDir: string, env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const v = (settings?.voice ?? {}) as Record<string, any>;
  const modelFromEnv = env.WXNODUS_VOICE_MODEL?.trim() || null;
  // 模型自动发现：<dataDir>/voice/models → CLI 安装目录（随包分发，任意 cwd 可找到）
  let modelPath = v.modelPath ?? modelFromEnv ?? null;
  if (!modelPath) {
    modelPath = findModelsIn(join(dataDir, 'voice')) ?? findModelsIn(installVoiceDir() ?? '') ?? null;
  }
  // A25：whisper-cli 自动发现——配置路径 → 环境变量 → <dataDir>/voice/bin/Release
  // → <dataDir>/voice/bin → CLI 安装目录 → PATH（findWhisperBin 兜底）
  let whisperBin = v.whisperBin ?? env.WXNODUS_VOICE_BIN?.trim() ?? null;
  if (!whisperBin) {
    whisperBin = findCliIn(join(dataDir, 'voice')) ?? findCliIn(installVoiceDir() ?? '') ?? null;
  }
  return {
    whisperBin,
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
    // W8-07：whisper 缺失但 SAPI 可用 → 兜底成立（Windows-only 定位）
    details.push(`Whisper: MISSING — 未找到 whisper-cli（whisper.cpp），请安装或设置 WXNODUS_VOICE_BIN${probeSapiStt() ? '（转写兜底：Windows SAPI 识别器可用）' : ''}`);
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
    // KF-005（第二层）：Windows 上带 position 的写入不推进文件指针——若指定 position=0，
    // 后续 write() 追加会从指针 0 起覆盖整个头部。header 顺序写（不指定 position）→
    // 指针推进到 44，数据追加其后再 finalize 回填大小字段
    writeSync(this.fd, h, 0, 44);
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
      // KF-005：分别写两个 4 字节字段——RIFF size 在 4-7、data size 在 40-43。
      // 此前 8 字节整块从偏移 4 写起：覆盖 8-11 的 'WAVE' 标识，且把 RIFF size
      // 错写进 data size 字段（头损坏，播放器拒读）
      const riff = Buffer.alloc(4);
      riff.writeUInt32LE(36 + this.bytes, 0);
      const data = Buffer.alloc(4);
      data.writeUInt32LE(this.bytes, 0);
      writeSync(this.fd, riff, 0, 4, 4);
      writeSync(this.fd, data, 0, 4, 40);
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

/**
 * W3 Voice facade：生产依赖组装——supervisor（异步 whisper spawn + 进程树终止）、
 * temp（录音 wav 清理）、transcriptStore（转写产物落盘，opaque ref 指向磁盘文件）。
 */
function voiceSessionDepsFor(dataDir: string, settings: Record<string, any> | undefined, env: NodeJS.ProcessEnv): VoiceSessionDeps {
  const cfg = resolveVoiceConfig(settings, dataDir, env);
  const transcriptsDir = join(dataDir, 'voice', 'transcripts');
  return {
    // KF-006：sttReady 只做存在性检查（whisper bin + 模型）——不调 checkVoice（其 hasFfmpeg
    // spawnSync 同步探测阻塞事件循环）。ffmpeg 是采集依赖，转写已有 wav 文件不需要
    sttReady: () => Boolean(findWhisperBin(cfg)) && Boolean(cfg.modelPath),
    supervisor: {
      spawn: async (_exe, args, options, signal) => {
        const bin = findWhisperBin(cfg);
        if (!bin) {
          return { processId: -1, exitCode: 1, signal: null, stdout: '', stderr: 'whisper-cli 未找到', timedOut: false, aborted: false };
        }
        // W8-08：必须传 -m 模型路径与 -l zh——此前只传 -f，whisper-cli 回落到 CWD 相对的
        // 默认模型 models/ggml-base.en.bin → failed to open → 真实资产在场仍 VOICE_WORKER_CRASHED；
        // -otxt：纯文本输出（默认 SRT 带时间戳——转写文本被字幕元数据污染）
        const fullArgs = ['-m', cfg.modelPath ?? '', '-l', 'zh', '-otxt', ...args];
        const child = spawn(bin, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout!.on('data', (c: Buffer) => { out += c; });
        child.stderr!.on('data', (c: Buffer) => { err += c; });
        return new Promise(resolve => {
          const timer = setTimeout(() => {
            stopRecordingProcess(child);
            resolve({ processId: child.pid ?? -1, exitCode: null, signal: null, stdout: out, stderr: err, timedOut: true, aborted: false });
          }, options.timeoutMs);
          const onAbort = () => {
            clearTimeout(timer);
            stopRecordingProcess(child);
            resolve({ processId: child.pid ?? -1, exitCode: null, signal: 'ABORT', stdout: out, stderr: err, timedOut: false, aborted: true });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          child.on('close', code => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            // -otxt：纯文本落在 <wav>.txt（stdout 是带时间戳的 SRT——读回干净文本）
            if (code === 0) {
              const fIdx = args.indexOf('-f');
              if (fIdx >= 0 && args[fIdx + 1]) {
                try {
                  const t = readFileSync(`${args[fIdx + 1]}.txt`, 'utf8').trim();
                  if (t) out = t;
                } catch { /* 产物缺失用 stdout 兜底 */ }
              }
            }
            resolve({ processId: child.pid ?? -1, exitCode: code, signal: null, stdout: out, stderr: err, timedOut: false, aborted: false });
          });
        });
      },
      terminateTree: async processId => {
        if (processId > 0) stopRecordingProcess({ pid: processId } as ReturnType<typeof spawn>);
        return { ok: true as const, value: undefined };
      },
    },
    temp: {
      remove: async path => {
        try {
          const { rmSync } = await import('node:fs');
          rmSync(path, { force: true });
        } catch { /* 清理失败静默 */ }
        return { ok: true as const, value: undefined };
      },
    },
    transcriptStore: {
      save: async (audioId, text) => {
        try {
          mkdirSync(transcriptsDir, { recursive: true });
          const { writeFileSync } = await import('node:fs');
          writeFileSync(join(transcriptsDir, audioId + '.txt'), text, 'utf8');
          return { ok: true as const, value: undefined };
        } catch (cause) {
          return { ok: false as const, error: { code: 'TRANSCRIPT_SAVE_FAILED', message: String(cause), messageKey: 'TRANSCRIPT_SAVE_FAILED', retryable: false } };
        }
      },
      load: async (ref: TranscriptRef) => {
        try {
          const id = ref.ref.slice('transcript://'.length);
          const { readFileSync } = await import('node:fs');
          return { ok: true as const, value: readFileSync(join(transcriptsDir, id + '.txt'), 'utf8') };
        } catch {
          return { ok: false as const, error: { code: 'TRANSCRIPT_NOT_FOUND', message: 'transcript 不存在', messageKey: 'TRANSCRIPT_NOT_FOUND', retryable: false } };
        }
      },
    },
  };
}

/** 结束 ffmpeg 采集进程（Windows taskkill / 其余 SIGTERM）。 */
function stopRecordingProcess(proc: ReturnType<typeof spawn>): void {
  // KF-006：pid<=0 无真实进程（伪造/占位 record）——跳过 taskkill 同步 spawn
  // （Windows taskkill spawnSync 实测 ~500ms 事件循环阻塞）
  if (!proc.pid || proc.pid <= 0) return;
  try {
    if (isWindows()) {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', timeout: 5000 });
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* 忽略 */ }
}

// ── SAPI STT 兜底（Windows-only 定位：whisper 缺失时用系统原生识别器，零模型下载）──
let sapiSttCache: boolean | null = null;

/** Windows 原生语音识别器探测（结果缓存——状态展示不反复 spawnSync） */
export function probeSapiStt(): boolean {
  if (!isWindows()) return false;
  if (sapiSttCache !== null) return sapiSttCache;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers().Count'],
      { stdio: 'pipe', timeout: 8000, windowsHide: true, encoding: 'utf8' });
    const n = Number(String(r.stdout ?? '').trim());
    sapiSttCache = Number.isFinite(n) && n > 0;
  } catch { sapiSttCache = false; }
  return sapiSttCache;
}

/** SAPI 识别器转写 wav（异步 spawn——不阻塞事件循环，KF-006 同款纪律） */
export function sapiTranscribe(wavPath: string, locale = 'zh-CN'): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      "$recs = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()",
      `$rid = ($recs | Where-Object { $_.Culture.Name -eq '${locale}' } | Select-Object -First 1).Id`,
      "if (-not $rid) { $rid = ($recs | Select-Object -First 1).Id }",
      '$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($rid)',
      '$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
      `$rec.SetInputToWaveFile('${wavPath.replace(/'/g, "''")}')`,
      '$r = $rec.Recognize()',
      '$rec.Dispose()',
      "if ($r) { Write-Output ('SAPI_TEXT:' + $r.Text) } else { Write-Output 'SAPI_TEXT:' }",
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout!.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr!.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      resolve({ ok: false, error: 'SAPI 转写超时（>60s）' });
    }, 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'SAPI 识别器进程启动失败' });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `SAPI 转写失败：${String(err.trim() || `exit ${code}`).slice(0, 200)}` });
        return;
      }
      const line = out.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('SAPI_TEXT:'));
      if (!line) {
        resolve({ ok: false, error: `SAPI 转写失败：${String(err.trim()).slice(0, 200) || '无识别结果'}` });
        return;
      }
      const text = line.slice('SAPI_TEXT:'.length).trim();
      resolve(text ? { ok: true, text } : { ok: false, error: 'SAPI 识别结果为空（音频无语音或识别器不匹配）' });
    });
  });
}

/**
 * 停止采集并本地转写（whisper.cpp 优先 / Windows SAPI 兜底）——W3 Voice facade：
 * whisper 路径执行委托 VoiceSessionService（状态机强制 + 产物落盘 + opaque ref 唯一出口），
 * kernel 读回文本仅供 TUI 兼容面；whisper 缺失时兜底 Windows 原生识别器（W8-07，
 * Windows-only 定位——系统组件零模型下载）。
 */
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
    // W8-07 Windows-only：whisper 缺失 → SAPI 原生识别器兜底（系统组件零下载——用户决策）
    if (!findWhisperBin(cfg)) {
      if (probeSapiStt()) {
        const r = await sapiTranscribe(rec.wavPath, 'zh-CN');
        return r.ok ? { ok: true, text: r.text.trim(), ms: Date.now() - t0 } : { ok: false, error: r.error };
      }
      return { ok: false, error: '未找到 whisper-cli（whisper.cpp）——安装后设置 WXNODUS_VOICE_BIN' };
    }
    if (!cfg.modelPath) return { ok: false, error: '缺少 whisper 模型——放置 ggml-*.bin 到 data/voice/models/' };
    // 权威委托：VoiceSessionService 执行转写（状态机 + 落盘 + opaque ref）
    const service = new VoiceSessionService(voiceSessionDepsFor(dataDir, settings, env));
    const started = await service.start('push-to-talk', AbortSignal.timeout(5_000));
    if (!started.ok) return { ok: false, error: started.error.code };
    const detected = service.speechDetected();
    if (!detected.ok) return { ok: false, error: detected.error.code };
    const audioId = randomUUID();
    const transcribed = await service.transcribe({ id: audioId, path: rec.wavPath, retention: 'session' }, AbortSignal.timeout(120_000));
    if (!transcribed.ok) return { ok: false, error: transcribed.error.code };
    const text = await service.readTranscript(transcribed.value.transcriptRef);
    if (!text.ok) return { ok: false, error: text.error.code };
    return { ok: true, text: text.value.trim(), ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: `转写异常：${String(e?.message ?? e).slice(0, 120)}` };
  }
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

function speakOnce(text: string): Promise<boolean> {
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

async function pumpTts(): Promise<void> {
  if (ttsRunning) return;
  ttsRunning = true;
  try {
    while (ttsQueue.length > 0) {
      const text = ttsQueue.shift()!;
      await speakOnce(text);
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
// W3-11：SAPI 探测集中到 kernel（入口层不直接执行进程）——开启 TTS 前一次性验证 System.Speech 可用
export function probeSapiTtsAvailable(): boolean {
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech'], {
      stdio: 'pipe', timeout: 8000, windowsHide: true,
    });
    if (result.status !== 0) return false;
    return true;
  } catch { return false; }
}

export function speakTts(text: string, _env: NodeJS.ProcessEnv = process.env): boolean {
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
  void pumpTts();
  return true;
}
