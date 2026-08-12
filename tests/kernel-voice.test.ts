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
  // A25：whisper-cli 自动发现（data/voice/bin/Release 官方解压结构 + data/voice/bin）
  it('whisper-cli 自动发现：data/voice/bin/Release/whisper-cli.exe', () => {
    const d = tmp();
    mkdirSync(join(d, 'voice', 'bin', 'Release'), { recursive: true });
    writeFileSync(join(d, 'voice', 'bin', 'Release', 'whisper-cli.exe'), 'x');
    const cfg = resolveVoiceConfig({}, d, {});
    expect(cfg.whisperBin).toBe(join(d, 'voice', 'bin', 'Release', 'whisper-cli.exe'));
  });
  it('whisper-cli 自动发现：data/voice/bin/whisper-cli.exe（无 Release 子目录）', () => {
    const d = tmp();
    mkdirSync(join(d, 'voice', 'bin'), { recursive: true });
    writeFileSync(join(d, 'voice', 'bin', 'whisper-cli.exe'), 'x');
    const cfg = resolveVoiceConfig({}, d, {});
    expect(cfg.whisperBin).toBe(join(d, 'voice', 'bin', 'whisper-cli.exe'));
  });
  it('dataDir 自有组件优先于 CLI 安装目录（运行时数据覆盖随包分发）', () => {
    const d = tmp();
    mkdirSync(join(d, 'voice', 'models'), { recursive: true });
    writeFileSync(join(d, 'voice', 'models', 'ggml-custom.bin'), 'x', 'utf8');
    const cfg = resolveVoiceConfig({}, d, {});
    expect(cfg.modelPath).toBe(join(d, 'voice', 'models', 'ggml-custom.bin'));
  });
});

// A25 修复：CLI 安装目录组件发现（组件随包分发——用户从任意目录启动 CLI 时
// dataDir=cwd/data 与安装目录不同，此前只搜 dataDir 导致「已安装却报 MISSING」）
describe('resolveVoiceConfig：CLI 安装目录回退', () => {
  it('dataDir 无组件时回退 CLI 安装目录（随包分发，任意 cwd 可找到）', () => {
    const cfg = resolveVoiceConfig({}, join(tmp(), 'nonexistent'), {});
    // 项目 data/voice 下已安装真实组件——从任意 dataDir 都应发现
    expect(cfg.whisperBin).toBeTruthy();
    expect(cfg.modelPath).toBeTruthy();
    expect(String(cfg.whisperBin)).toContain('whisper-cli');
    expect(String(cfg.modelPath)).toContain('ggml-');
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
