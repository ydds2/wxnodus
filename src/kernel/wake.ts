// src/kernel/wake.ts — 唤醒模式（wake word）：持续监听 + 能量门控 + whisper 短窗转写匹配
// 链路：ffmpeg 持续采集 PCM 管道 → 滑动窗口（默认 2.5s）→ 窗口能量低于阈值跳过转写
//       （省 CPU）→ whisper tiny 本地转写 → 唤醒词匹配（wxnodus/唤醒/wake）→ onWake 回调。
// 纯自研（复用 voice.ts 的采集器与 WavWriter、vad.ts 的能量工具）；音频仅内存不落盘（临时 wav 用后即删）。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { pcmToInt16, rmsOfBlock } from './vad.js';
import { WavWriter } from './voice.js';

/** 唤醒词变体（大小写不敏感、容忍前后缀——"hey wxnodus" 也能命中）。 */
export const WAKE_WORDS = ['wxnodus', '唤醒', 'wake', '沃克斯诺德斯'];

/**
 * 唤醒词匹配。英文唤醒词（wake/wxnodus）用词边界（防 wakeboard 误唤醒）；
 * 中文（唤醒/沃克斯诺德斯）直接包含匹配。纯函数——直接单测。
 */
export function matchWakeWord(text: string, words: readonly string[] = WAKE_WORDS): string | null {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：'"“”\s]+/g, ' ');

  for (const w of words) {
    const key = w.toLowerCase();

    if (/^[a-z]+$/.test(key)) {
      // 英文唤醒词：词边界（前后非字母数字或字符串端点）
      if (new RegExp(`(^|[^a-z0-9])${key}([^a-z0-9]|$)`).test(t)) {
        return w;
      }
    } else if (t.includes(key)) {
      return w;
    }
  }

  return null;
}

export interface WakeConfig {
  dataDir: string;
  whisperBin: string;
  modelPath: string;
  /** 采集设备（缺省自动枚举——voice.ts detectAudioDevice） */
  device?: string | null;
  /** 转写窗口 ms（默认 2500） */
  windowMs?: number;
  /** 转写轮询间隔 ms（默认 1200） */
  intervalMs?: number;
  /** 窗口 RMS 能量门控（低于跳过转写；默认 300） */
  minRms?: number;
  /** 采样率（默认 16000） */
  sampleRate?: number;
  /** 命中唤醒词回调（gateway：播报"我在"+ 进入 VAD 待命录音） */
  onWake: (word: string) => void;
  /** 异常回调（组件缺失/转写失败——不假装可用） */
  onError?: (error: string) => void;
}

/**
 * 唤醒监听器。start 后持续采集；stop 释放进程与定时器。
 * 转写用异步 spawn（不阻塞主线程）。
 */
export class WakeListener {
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private chunkBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private transcribing = false;
  private stopped = false;

  constructor(private cfg: WakeConfig) {}

  /** 启动持续采集。返回失败原因（缺 ffmpeg/设备/whisper/模型——诚实降级）。 */
  start(): { ok: true } | { ok: false; error: string } {
    const { whisperBin, modelPath } = this.cfg;
    if (!whisperBin || !modelPath) {
      return { ok: false, error: '唤醒模式需要 whisper-cli 与模型（/voice status 查看缺失项）' };
    }
    if (!this.cfg.device) {
      // 懒加载避免循环依赖：device 由调用方（gateway）经 resolveVoiceConfig 传入
      return { ok: false, error: '未指定录音设备（WXNODUS_VOICE_DEVICE 或自动枚举失败）' };
    }
    try {
      const args = [
        '-y', '-f', 'dshow', '-i', `audio=${this.cfg.device}`,
        '-ar', String(this.cfg.sampleRate ?? 16000), '-ac', '1', '-c:a', 'pcm_s16le',
        '-f', 's16le', 'pipe:1',
      ];
      this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      this.proc.on('error', () => {
        if (!this.stopped) this.cfg.onError?.('ffmpeg 采集启动失败（麦克风被占用？）');
      });
      this.proc.stdout!.on('data', (chunk: Buffer) => {
        this.chunks.push(chunk);
        this.chunkBytes += chunk.length;
        const max = (this.cfg.sampleRate ?? 16000) * 2 * ((this.cfg.windowMs ?? 2500) / 1000);
        while (this.chunkBytes > max && this.chunks.length > 1) {
          this.chunkBytes -= this.chunks.shift()!.length;
        }
      });
      this.stopped = false;
      this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs ?? 1200);
      this.timer.unref?.();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: `唤醒监听启动失败：${String(e?.message ?? e).slice(0, 120)}` };
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.proc) {
      try {
        spawn('taskkill', ['/pid', String(this.proc.pid), '/t', '/f'], { stdio: 'ignore' });
      } catch { /* 忽略 */ }
      this.proc = null;
    }
    this.chunks = [];
    this.chunkBytes = 0;
  }

  /** 轮询：窗口能量门控 → 转写 → 匹配唤醒词 */
  private async tick(): Promise<void> {
    if (this.transcribing || this.stopped || !this.proc) {
      return;
    }
    const win = this.windowBuffer();
    if (win.length < (this.cfg.sampleRate ?? 16000) * 2 * 0.4) {
      return; // <400ms 无意义
    }
    if (rmsOfBlock(pcmToInt16(win)) < (this.cfg.minRms ?? 300)) {
      return; // 静音窗口——跳过转写省 CPU
    }
    await this.transcribe(win);
  }

  private windowBuffer(): Buffer {
    const out = Buffer.alloc(this.chunkBytes);
    let off = 0;
    for (const c of this.chunks) {
      c.copy(out, off);
      off += c.length;
    }
    return out;
  }

  /** 异步 whisper 转写窗口音频 → 匹配唤醒词（临时 wav 用后即删） */
  private async transcribe(buf: Buffer): Promise<void> {
    this.transcribing = true;
    const base = join(this.cfg.dataDir, 'voice', `wake-${Date.now()}-${randomUUID().slice(0, 6)}`);
    try {
      const writer = new WavWriter(`${base}.wav`, this.cfg.sampleRate ?? 16000);
      writer.write(buf);
      writer.finalize();
      const text = await whisperToText(this.cfg.whisperBin, this.cfg.modelPath, `${base}.wav`, `${base}.txt`);
      const hit = matchWakeWord(text);
      if (hit && !this.stopped) {
        this.cfg.onWake(hit);
      }
    } catch (e: any) {
      if (!this.stopped) this.cfg.onError?.(`唤醒转写失败：${String(e?.message ?? e).slice(0, 120)}`);
    } finally {
      this.transcribing = false;
      for (const f of [`${base}.wav`, `${base}.txt`]) {
        try { if (existsSync(f)) unlinkSync(f); } catch { /* 忽略 */ }
      }
    }
  }
}

/** 异步 whisper 转写（spawn + promise，不阻塞主线程）。 */
export function whisperToText(
  bin: string,
  modelPath: string,
  wavPath: string,
  outBase: string,
  timeoutMs = 60000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-m', modelPath, '-f', wavPath, '-otxt', '-of', outBase, '-np'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      reject(new Error('转写超时'));
    }, timeoutMs);
    child.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`whisper 退出码 ${code ?? '?'}`));
        return;
      }
      try {
        resolve(existsSync(`${outBase}.txt`) ? readFileSync(`${outBase}.txt`, 'utf8').trim() : '');
      } catch (e: any) {
        reject(e);
      }
    });
  });
}
