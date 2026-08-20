// tests/regressions/known-failures/kf-007-screenshot-dimensions.regression.test.ts — KF-007 迁移绿回归
// 契约：captureScreen 必须返回真实像素宽高（正整数）——node-screenshots Monitor 的
// width/height 是方法不是属性（读属性拿到函数本身 → NaN）；必须调用 m.width()/m.height()。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { captureScreen } from '../../../src/kernel/computer/index.js';

describe('KF-007 resolved: 截图尺寸真实像素（正整数）', () => {
  it('真实桌面捕获返回有限正整数宽高（原生模块可用时）', async () => {
    const shot = await captureScreen();
    expect(shot).not.toBeNull();
    if (!shot) return;
    expect(Number.isFinite(shot.width)).toBe(true);
    expect(Number.isFinite(shot.height)).toBe(true);
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    // PNG 载荷与尺寸一致（非空且魔数正确）
    expect(shot.png.length).toBeGreaterThan(8);
    expect(shot.png.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });

  it('源锚点：读取尺寸必须调用方法 width()/height()（不是属性读取）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/computer/index.ts'), 'utf8');
    const block = src.slice(src.indexOf('export async function captureScreen'), src.indexOf('export class ComputerUse'));
    expect(block).toContain('m.width()');
    expect(block).toContain('m.height()');
    expect(block).not.toMatch(/\(m as any\)\.width\b/);
    expect(block).not.toMatch(/\(m as any\)\.height\b/);
  });
});
