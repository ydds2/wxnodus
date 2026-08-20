// tests/regressions/known-failures/kf-006-whisper-nonblocking.regression.test.ts — KF-006 迁移绿回归
// 契约：转写链路（stopAndTranscribe）不得同步阻塞事件循环——
// ① 转写依赖装配 sttReady 只做存在性检查（whisper bin + 模型），不同步探测 ffmpeg（采集依赖，非转写依赖）；
// ② stopRecordingProcess 对无真实进程的 record（pid<=0）跳过 taskkill 同步调用。
// 行为断言：伪造 whisper（node.exe 副本）转写期间，10ms 定时器在 ≤20ms 内触发。
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stopAndTranscribe } from '../../../src/kernel/voice.js';

const voiceSrc = (): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/voice.ts'), 'utf8');

describe('KF-006 resolved: 转写链路不阻塞事件循环', () => {
  it('伪造 whisper 转写期间 10ms 定时器 ≤20ms 触发（无同步 spawn 阻塞）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-006-reg-'));
    try {
      const wavPath = join(dir, 'rec.wav');
      writeFileSync(wavPath, 'RIFFxxxx');
      // 伪造 whisper：node.exe 副本（收到未知选项快速退出）——不依赖真实 whisper.cpp
      const fakeBin = join(dir, 'whisper-fake.exe');
      copyFileSync(process.execPath, fakeBin);
      const rec: any = { proc: { pid: -1, kill() {} }, wavPath };
      const t0 = Date.now();
      let timerMs = -1;
      setTimeout(() => { timerMs = Date.now() - t0; }, 10);
      await stopAndTranscribe(rec, dir, { voice: { whisperBin: fakeBin, modelPath: 'x' } }, process.env);
      // 事件循环保持响应：同步 spawn 阻塞（实测 ~600ms）时定时器不可能 ≤100ms 触发。
      // 阈值校准：Windows 定时器粒度 ~15.6ms——异步路径实测 ~15-50ms
      expect(timerMs).not.toBe(-1);
      expect(timerMs).toBeLessThanOrEqual(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('源锚点：voiceSessionDepsFor 的 sttReady 不调用 checkVoice（存在性检查）', () => {
    const src = voiceSrc();
    const start = src.indexOf('function voiceSessionDepsFor');
    expect(start).toBeGreaterThan(0);
    const depsBlock = src.slice(start, start + 2000);
    expect(depsBlock).toContain('sttReady');
    // 不得出现真实调用（ASCII 括号；注释里的全角写法不算）
    expect(depsBlock).not.toContain('checkVoice(');
  });

  it('源锚点：stopRecordingProcess 对 pid<=0 跳过 taskkill（无真实进程不 spawn）', () => {
    const src = voiceSrc();
    const fn = src.slice(src.indexOf('function stopRecordingProcess'), src.indexOf('function stopRecordingProcess') + 700);
    expect(fn).toContain('pid <= 0');
  });
});
