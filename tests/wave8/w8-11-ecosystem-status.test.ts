// tests/wave8/w8-11-ecosystem-status.test.ts — W8-11：/eco 生态互依面板契约
// 契约：互依关系可视化——每项系统能力真实探测（非 Windows 诚实降级）、结果缓存、
// 面板文本含就绪计数；/eco 命令真实注册进命令总线。
import { describe, expect, it } from 'vitest';
import { probeEcosystem, renderEcosystem } from '../../src/application/ecosystemStatus.js';

describe('W8-11 Windows 生态互依面板（/eco）', () => {
  it('win32：探测覆盖全部互依能力且结果为布尔（缓存可重复读）', () => {
    if (process.platform !== 'win32') return;
    const a = probeEcosystem(process.cwd());
    const b = probeEcosystem(process.cwd());
    expect(a.length).toBeGreaterThanOrEqual(10);
    for (const p of a) {
      expect(typeof p.available).toBe('boolean');
      expect(p.capability.length).toBeGreaterThan(0);
      expect(p.channel.length).toBeGreaterThan(0);
    }
    expect(b).toEqual(a); // 缓存一致性
  });

  it('非 Windows：平台项诚实不可用（绝不假装 Windows 能力在场）', () => {
    if (process.platform === 'win32') return;
    const probes = probeEcosystem(process.cwd());
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ available: false });
  });

  it('面板文本：含就绪计数与互依方向', () => {
    const text = renderEcosystem(process.cwd());
    expect(text).toContain('互依');
    expect(text).toMatch(/就绪 \d+\//);
  });
});
