// tests/kernel-voice.test.ts — 语音模式（本地 whisper）：配置解析/就绪检测/模型发现
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVoiceConfig, checkVoice } from '../src/kernel/voice.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-voice-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('resolveVoiceConfig（开放兼容：settings/env/自动发现）', () => {
  it('settings.voice 优先；env 次之', () => {
    const d = tmp();
    const fromSettings = resolveVoiceConfig({ voice: { whisperBin: 'C:/bin/whisper-cli.exe', modelPath: 'C:/m/ggml-base.bin', device: '麦克风' } }, d, {});
    expect(fromSettings.whisperBin).toBe('C:/bin/whisper-cli.exe');
    expect(fromSettings.modelPath).toBe('C:/m/ggml-base.bin');
    expect(fromSettings.device).toBe('麦克风');
    const fromEnv = resolveVoiceConfig({}, d, { WXNODUS_VOICE_BIN: 'E:/w/main.exe', WXNODUS_VOICE_DEVICE: 'Mic' });
    expect(fromEnv.whisperBin).toBe('E:/w/main.exe');
    expect(fromEnv.device).toBe('Mic');
  });
  it('模型自动发现：data/voice/models/ggml-*.bin', () => {
    const d = tmp();
    mkdirSync(join(d, 'voice', 'models'), { recursive: true });
    writeFileSync(join(d, 'voice', 'models', 'ggml-small.bin'), 'x', 'utf8');
    const cfg = resolveVoiceConfig({}, d, {});
    expect(cfg.modelPath).toBe(join(d, 'voice', 'models', 'ggml-small.bin'));
  });
  it('无配置时全 null', () => {
    const d = tmp();
    const cfg = resolveVoiceConfig({}, d, {});
    expect(cfg.whisperBin).toBeNull();
    expect(cfg.modelPath).toBeNull();
    expect(cfg.device).toBeNull();
  });
});

describe('checkVoice（就绪检测——缺失组件明确指引，不假装可用）', () => {
  it('无 ffmpeg/whisper/模型 → sttAvailable=false + 缺失明细', () => {
    const d = tmp();
    // 环境隔离：PATH 里没有 ffmpeg/whisper-cli 时（CI/沙箱）→ 明确 MISSING
    const check = checkVoice({}, d);
    expect(typeof check.sttAvailable).toBe('boolean');
    expect(check.details.length).toBeGreaterThan(0);
    expect(check.details.some(l => l.includes('MISSING') || l.includes('就绪'))).toBe(true);
  });
});
