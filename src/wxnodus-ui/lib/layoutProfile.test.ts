// src/wxnodus-ui/lib/layoutProfile.test.ts — 阶段 1：布局条件纯函数（单栏几何/状态可见性/overlay 模式/glyph set）
import { describe, expect, it } from 'vitest';
import { layoutProfileFor, statusSegmentsFor } from './layoutProfile.js';
import type { TerminalCapabilities, TerminalTier } from './terminalTier.js';

const caps = (glyphSet: TerminalCapabilities['glyphSet'], extra: Partial<TerminalCapabilities> = {}): TerminalCapabilities => ({
  sync2026: glyphSet === 'full', decstbm: glyphSet === 'full', truecolor: glyphSet === 'full',
  osc8: glyphSet === 'full', clipboard: glyphSet === 'full', oscNotify: glyphSet === 'full',
  mouse: glyphSet === 'full', extendedKeys: glyphSet === 'full', glyphSet, ...extra,
});

describe('layoutProfile 单栏几何（阶段 1）', () => {
  it.each(['modern', 'cmd', 'no-vt'] as const)('%s 档主列宽恒等于终端宽度（不引入第二列）', (tier) => {
    for (const cols of [40, 60, 72, 80, 96, 120]) {
      const p = layoutProfileFor(tier, caps('full'), cols);
      expect(p.mainWidth).toBe(cols);
    }
  });

  it.each([40, 60, 72, 80, 96, 120])('%d 列时状态段断点与既有 statusBarSegments 契约一致', (cols) => {
    const s = statusSegmentsFor(cols);
    expect(s.compactCtx).toBe(cols < 72);
    expect(s.bar).toBe(cols >= 72);
    expect(s.duration).toBe(cols >= 76);
    expect(s.compressions).toBe(cols >= 80);
    expect(s.voice).toBe(cols >= 84);
    expect(s.cost).toBe(cols >= 96);
    // 余额（💰）与 bar 同档起步（72+——钱最要紧）；token 区间（📊）与 cost 同档（96+）
    expect(s.balance).toBe(cols >= 72);
    expect(s.usage).toBe(cols >= 96);
  });

  it('glyphSet 透传：full/bmp/ascii 三档不互相污染', () => {
    expect(layoutProfileFor('modern', caps('full'), 80).glyphSet).toBe('full');
    expect(layoutProfileFor('cmd', caps('bmp'), 80).glyphSet).toBe('bmp');
    expect(layoutProfileFor('no-vt', caps('ascii'), 80).glyphSet).toBe('ascii');
  });

  it('overlay 模式：modern/cmd → float；no-vt → none（不挂载 TUI）', () => {
    expect(layoutProfileFor('modern', caps('full'), 80).overlayMode).toBe('float');
    expect(layoutProfileFor('cmd', caps('bmp'), 80).overlayMode).toBe('float');
    expect(layoutProfileFor('no-vt', caps('ascii'), 80).overlayMode).toBe('none');
  });

  it('spinner 字形：仅 full 档用 braille，bmp/ascii 收敛为 ascii 帧', () => {
    expect(layoutProfileFor('modern', caps('full'), 80).spinner).toBe('braille');
    expect(layoutProfileFor('cmd', caps('bmp'), 80).spinner).toBe('ascii');
    expect(layoutProfileFor('no-vt', caps('ascii'), 80).spinner).toBe('ascii');
  });
});
