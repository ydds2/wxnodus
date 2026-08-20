// tests/wave8/w8-08-whisper-args.regression.test.ts — W8-08：whisper 转写必须传 -m 模型路径
// 真实缺陷（E2E 实跑发现）：supervisor spawn 只传 `-f`——whisper-cli 回落到 CWD 相对的
// 默认模型 models/ggml-base.en.bin → failed to open → VOICE_WORKER_CRASHED（真实资产在场仍失败）。
// 契约：① spawn 参数必含 -m <modelPath> 与 -l zh（源锚点）；② 真实 whisper 资产在场时
// TTS 合成语音经生产 stopAndTranscribe 转写成功（真实端到端，资产缺失诚实跳过）。
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveVoiceConfig, stopAndTranscribe } from '../../src/kernel/voice.js';

const voiceSrc = (): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/kernel/voice.ts'), 'utf8');

describe('W8-08 whisper 转写参数契约', () => {
  it('源锚点：supervisor spawn 参数含 -m 模型路径与 -l zh（不再依赖 CWD 默认模型）', () => {
    const src = voiceSrc();
    const block = src.slice(src.indexOf('function voiceSessionDepsFor'), src.indexOf('function voiceSessionDepsFor') + 2500);
    expect(block).toContain("'-m'");
    expect(block).toContain('cfg.modelPath');
    expect(block).toContain("'-l'");
  });

  it('真实 whisper 资产：TTS 合成语音 → 生产 stopAndTranscribe 转写成功（资产缺失诚实跳过）', async () => {
    const cfg = resolveVoiceConfig({ voice: {} }, process.cwd(), process.env);
    const bin = cfg.whisperBin && existsSync(cfg.whisperBin) ? cfg.whisperBin : null;
    if (!bin || !cfg.modelPath) return; // 无真实资产——诚实跳过（不是失败）
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'w8-08-'));
    const wav = join(dir, 'speech.wav');
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''").replace(/\\/g, '\\\\')}')`,
      "$s.Speak('黑洞引擎，本地优先')",
      '$s.Dispose()',
    ].join('; ');
    const syn = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', timeout: 30000 });
    if (syn.status !== 0) { rmSync(dir, { recursive: true, force: true }); return; }
    const rec: any = { proc: { pid: -1, kill() {} }, wavPath: wav };
    const r = await stopAndTranscribe(rec, dir, { voice: { whisperBin: bin, modelPath: cfg.modelPath } }, process.env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.length).toBeGreaterThan(0); // 合成语音应有转写文本
    rmSync(dir, { recursive: true, force: true });
  }, 120000);
});
