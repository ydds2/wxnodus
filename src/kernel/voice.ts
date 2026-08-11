// src/kernel/voice.ts — 语音模式（本地 whisper：完全离线，音频不出机）
// 链路：ffmpeg（dshow 采集麦克风 → wav）→ whisper.cpp（本地转写 → 文本）
//        → TTS（Windows SAPI PowerShell 朗读，可选）
// 配置（开放兼容，settings.voice 或 env 覆盖）：
//   whisperBin:  whisper-cli 可执行（默认 PATH 里找 whisper-cli / main）
//   modelPath:   ggml 模型文件（默认 <dataDir>/voice/models/ggml-*.bin 自动发现）
//   device:      ffmpeg dshow 采集设备名（默认自动枚举第一个音频设备）
//   WXNODUS_VOICE_* env 同名覆盖；缺失组件时 checkVoice 给出明确指引（不假装可用）
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
    // 无音频设备（纯扬声器环境）——返回第一个 (audio) 设备名
    return null;
  } catch { return null; }
}

// ── 录音会话（start → ffmpeg 后台采集 → stop → 转写）────────
export interface RecordingSession {
  proc: ReturnType<typeof spawn>;
  wavPath: string;
  startedAt: number;
}

export function startRecording(dataDir: string, settings: Record<string, any> | undefined, env: NodeJS.ProcessEnv = process.env): { ok: true; rec: RecordingSession } | { ok: false; error: string } {
  const cfg = resolveVoiceConfig(settings, dataDir, env);
  if (!hasFfmpeg()) return { ok: false, error: '缺少 ffmpeg——请安装并加入 PATH（麦克风采集依赖）' };
  const device = cfg.device || detectAudioDevice(env);
  if (isWindows() && !device) return { ok: false, error: '未找到录音设备——设置 WXNODUS_VOICE_DEVICE 指定麦克风设备名' };
  try {
    const voiceDir = join(dataDir, 'voice');
    mkdirSync(voiceDir, { recursive: true });
    const wavPath = join(voiceDir, `rec-${Date.now()}-${randomUUID().slice(0, 6)}.wav`);
    // Windows dshow 采集（16kHz 单声道，whisper 友好）；非 Windows 走 PulseAudio 默认源
    const args = isWindows()
      ? ['-y', '-f', 'dshow', '-i', `audio=${device}`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]
      : ['-y', '-f', 'pulse', '-i', 'default', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath];
    const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
    proc.on('error', () => { /* 采集进程错误由 stop 时检测 */ });
    return { ok: true, rec: { proc, wavPath, startedAt: Date.now() } };
  } catch (e: any) {
    return { ok: false, error: `采集启动失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** 停止采集并本地转写（whisper.cpp）；返回文本或错误 */
export async function stopAndTranscribe(rec: RecordingSession, dataDir: string, settings: Record<string, any> | undefined, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; text: string; ms: number } | { ok: false; error: string }> {
  const t0 = Date.now();
  try {
    // 结束采集：ffmpeg 需要 SIGTERM（Windows taskkill）才能写完 wav 尾部
    if (isWindows()) {
      try { spawnSync('taskkill', ['/pid', String(rec.proc.pid), '/t', '/f'], { stdio: 'ignore', timeout: 5000 }); } catch { /* 忽略 */ }
    } else {
      rec.proc.kill('SIGTERM');
    }
    // 等待文件落盘（<1s；ffmpeg 终止后 wav 头已写）
    await new Promise(r => setTimeout(r, 600));
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
export function speakTts(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isWindows()) return false;
  const safe = String(text ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！？、；：""''（）\s,.!?;:()\-+]/g, ' ').slice(0, 300);
  if (!safe.trim()) return false;
  try {
    const ps = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${safe.replace(/'/g, "''")}')`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 30000 });
    return r.status === 0;
  } catch { return false; }
}
