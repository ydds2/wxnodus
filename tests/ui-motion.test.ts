// tests/ui-motion.test.ts — 动效帧序列纯函数（确定性/循环/降级档位）
import { describe, it, expect, afterEach } from 'vitest';
import { accretionRing, supernova, starfield, breatheColor, toolRain, motionTierFor } from '../src/wxnodus-ui/lib/motion.js';

const NO_ANIM = 'WXNODUS_NO_ANIM';

afterEach(() => {
  delete process.env[NO_ANIM];
});

describe('motion 帧序列确定性', () => {
  it('accretionRing: 4 帧循环且每帧非空', () => {
    for (let i = 0; i < 16; i++) {
      const f = accretionRing(i);
      expect(f.length).toBeGreaterThan(0);
      expect(f).toEqual(accretionRing(i + 4)); // 循环（phase 4 + core 2 的最小公倍数）
      expect(f).toEqual(accretionRing(i + 8));
      expect(f.every(line => typeof line === 'string' && line.length > 0)).toBe(true);
    }
  });
  it('supernova: 5 帧内爆发→消散，第 5 帧起为空', () => {
    for (let i = 0; i < 5; i++) {
      expect(supernova(i).length).toBeGreaterThan(0);
    }
    expect(supernova(5)).toBe('');
    expect(supernova(9)).toBe('');
  });
  it('starfield: 同种子同帧输出一致，帧号变化则不同', () => {
    expect(starfield(3, 80, 42)).toBe(starfield(3, 80, 42));
    expect(starfield(3, 80, 42)).not.toBe(starfield(4, 80, 42));
    // 列数超限仍合法（不越界输出）
    expect(starfield(0, 10, 1).length).toBeGreaterThan(0);
  });
  it('breatheColor: 合法 ansi256 灰阶脉动', () => {
    for (let i = 0; i < 48; i++) {
      const v = breatheColor(i);
      expect(v).toMatch(/^ansi256\(\d{1,3}\)$/);
      const n = Number(v.slice(8, -1));
      expect(n).toBeGreaterThanOrEqual(232);
      expect(n).toBeLessThanOrEqual(255);
    }
  });
  it('toolRain: 帧间确定性，列号不越界', () => {
    const f0 = toolRain(0, 60);
    expect(f0).toBe(toolRain(0, 60));
    expect(f0).not.toBe(toolRain(1, 60));
    // 窄屏：cols 小于步长时输出为空串（合法）
    expect(toolRain(2, 1)).toBe('');
  });
});

describe('motionTier 三级降级', () => {
  it('无环境变量时按终端档位：modern→full / cmd→subtle / no-vt→off / 未知→full', () => {
    expect(motionTierFor('modern', false)).toBe('full');
    expect(motionTierFor('cmd', false)).toBe('subtle');
    expect(motionTierFor('no-vt', false)).toBe('off');
    expect(motionTierFor(null, false)).toBe('full');
  });
  it('WXNODUS_NO_ANIM=1 强制 off（任何档位）', () => {
    expect(motionTierFor('modern', true)).toBe('off');
    expect(motionTierFor('cmd', true)).toBe('off');
    expect(motionTierFor('no-vt', true)).toBe('off');
  });
  it('motionTier 默认入口读取运行时档位（未注入 → full）', async () => {
    const { motionTier } = await import('../src/wxnodus-ui/lib/motion.js');
    // 测试环境未 setTuiTerminalTier → null → full（fail-open 于动画无害，非安全路径）
    expect(motionTier()).toBe('full');
  });
});
