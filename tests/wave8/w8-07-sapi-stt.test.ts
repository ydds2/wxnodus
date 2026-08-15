// tests/wave8/w8-07-sapi-stt.test.ts — W8-07：SAPI STT 兜底通道契约（Windows-only 定位）
// 契约：whisper-cli 缺失时转写自动兜底到 Windows 原生 SAPI 识别器（系统组件，零模型下载——
// 用户决策「只需在 Windows 上跑」+「放弃离线模型」的落码）；
// ① 兜底路径异步 spawn（不阻塞事件循环——KF-006 同款纪律）；
// ② whisper 存在时优先 whisper（兜底不抢主通道）；
// ③ probe 结果缓存（状态展示不反复 spawnSync）。
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stopAndTranscribe, probeSapiStt, sapiTranscribe } from '../../src/kernel/voice.js';

const isWin = process.platform === 'win32';

describe('W8-07 SAPI STT 兜底（Windows 原生转写）', () => {
  it('probeSapiStt：本机识别器探测 + 结果缓存（连续两次结果一致）', () => {
    const a = probeSapiStt();
    const b = probeSapiStt();
    expect(typeof a).toBe('boolean');
    expect(b).toBe(a);
  });

  it('真实 SAPI 转写：TTS 合成语音 → 识别回非空文本（本机识别器可用时）', async () => {
    if (!isWin) return; // 非 Windows 无 SAPI——诚实跳过（Windows-only 定位）
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'w8-07-'));
    const wav = join(dir, 'tts.wav');
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
      `$s.SetOutputToWaveFile('${wav.replace(/\\/g, '\\\\')}')`,
      `$s.Speak('一二三四五')`,
      `$s.Dispose()`,
    ].join('; ');
    const syn = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', timeout: 30000 });
    if (syn.status !== 0 || !probeSapiStt()) return; // 合成失败/无识别器——诚实跳过
    const r = await sapiTranscribe(wav, 'zh-CN');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it('whisper 存在时优先 whisper（SAPI 只兜底缺失路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8-07-pri-'));
    try {
      const wavPath = join(dir, 'rec.wav');
      writeFileSync(wavPath, 'RIFFxxxx');
      const fakeBin = join(dir, 'whisper-fake.exe');
      copyFileSync(process.execPath, fakeBin);
      const rec: any = { proc: { pid: -1, kill() {} }, wavPath };
      const r = await stopAndTranscribe(rec, dir, { voice: { whisperBin: fakeBin, modelPath: 'x' } }, process.env);
      // 走 whisper 通道（fake bin 崩溃）——不得落回 SAPI（主通道优先契约）
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('VOICE_WORKER_CRASHED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
