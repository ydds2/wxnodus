// tests/regressions/known-failures/kf-005-wav-header.regression.test.ts — KF-005 迁移绿回归
// 契约：WavWriter.finalize 回填大小字段不得覆盖 'WAVE'/'fmt ' 标识——
// RIFF size 写 4-7、data size 写 40-43，两处字段各自正确（原实现 8 字节整块从偏移 4 写起，
// 覆盖 'WAVE' 且把 RIFF size 错写进 data size 字段）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WavWriter } from '../../../src/kernel/voice.js';

describe('KF-005 resolved: WAV 头回填正确（不破坏 RIFF 标识）', () => {
  it('写入 100 字节后 finalize：RIFF/WAVE/fmt/data 标识完整、双 size 字段正确', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-005-reg-'));
    try {
      const p = join(dir, 'rec.wav');
      const w = new WavWriter(p, 16000, 1);
      w.write(Buffer.alloc(100, 0x55));
      w.finalize();
      const bytes = readFileSync(p);
      expect(bytes.length).toBe(44 + 100);
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('latin1')).toBe('WAVE');
      expect(bytes.subarray(12, 16).toString('latin1')).toBe('fmt ');
      expect(bytes.subarray(36, 40).toString('latin1')).toBe('data');
      expect(bytes.readUInt32LE(4)).toBe(36 + 100); // RIFF 块大小 = 36 + 数据字节
      expect(bytes.readUInt32LE(40)).toBe(100); // data 块大小
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalize 幂等且已关闭后写入被忽略（大小不漂移）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-005-reg-'));
    try {
      const p = join(dir, 'rec.wav');
      const w = new WavWriter(p, 8000, 2);
      w.write(Buffer.alloc(64));
      w.finalize();
      w.write(Buffer.alloc(999)); // 关闭后写入应忽略
      w.finalize(); // 幂等
      const bytes = readFileSync(p);
      expect(bytes.readUInt32LE(4)).toBe(36 + 64);
      expect(bytes.readUInt32LE(40)).toBe(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
