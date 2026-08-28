// src/wxnodus-ui/components/appChrome-indicator.test.ts — 阶段 1：busy 指示器字形层级降级合同
// cmd/ascii 档绝不发射 astral emoji 或盲文帧（即使显式 /indicator emoji|unicode）。
import { afterEach, describe, expect, it } from 'vitest';
import { renderIndicator } from './appChrome.js';
import { setTuiTerminalTier } from '../lib/terminalTier.js';
import type { TerminalCapabilities } from '../lib/terminalTier.js';

const caps = (glyphSet: TerminalCapabilities['glyphSet']): TerminalCapabilities => ({
  sync2026: glyphSet === 'full', decstbm: glyphSet === 'full', truecolor: glyphSet === 'full',
  osc8: glyphSet === 'full', clipboard: glyphSet === 'full', oscNotify: glyphSet === 'full',
  mouse: glyphSet === 'full', extendedKeys: glyphSet === 'full', glyphSet,
});

const asciiOnly = (s: string) => [...s].every(ch => (ch.codePointAt(0) ?? 0) <= 0x7f);

afterEach(() => { setTuiTerminalTier(null as never); });

describe('busy 指示器层级降级（renderIndicator）', () => {
  it('full 档：emoji 帧循环含 astral 字形、unicode 帧为盲文（现状零变化）', () => {
    setTuiTerminalTier({ tier: 'modern', reason: 'test', capabilities: caps('full') });
    // ⚕ 首帧是 BMP，astral 帧（🌀🤔🍵🔮）在循环中出现——检查整轮而非首帧。
    const frames = Array.from({ length: 6 }, (_, tick) => renderIndicator('emoji', tick).frame);
    expect(frames.some(f => [...f].some(ch => (ch.codePointAt(0) ?? 0) > 0xffff))).toBe(true);
    const unicode = renderIndicator('unicode', 0);
    expect(unicode.frame.charCodeAt(0)).toBeGreaterThanOrEqual(0x2800);
  });

  it.each(['bmp', 'ascii'] as const)('%s 档：emoji/unicode 帧全部退回纯 ASCII（无 astral、无盲文）', (glyphSet) => {
    setTuiTerminalTier({ tier: glyphSet === 'bmp' ? 'cmd' : 'no-vt', reason: 'test', capabilities: caps(glyphSet) });
    for (const style of ['emoji', 'unicode'] as const) {
      for (let tick = 0; tick < 8; tick += 1) {
        const r = renderIndicator(style, tick);
        expect(asciiOnly(r.frame), `${glyphSet}/${style}#${tick}: ${r.frame}`).toBe(true);
      }
    }
  });

  it('kaomoji/ascii 风格在所有层级保持既有帧（BMP kaomoji / ASCII）', () => {
    for (const glyphSet of ['full', 'bmp', 'ascii'] as const) {
      setTuiTerminalTier({ tier: 'modern', reason: 'test', capabilities: caps(glyphSet) });
      expect(renderIndicator('kaomoji', 0).frame.length).toBeGreaterThan(0);
      expect(asciiOnly(renderIndicator('ascii', 0).frame)).toBe(true);
    }
  });

  it('降级后 unicode 风格仍保持无 verb 旋转语义（showVerb=false）', () => {
    setTuiTerminalTier({ tier: 'cmd', reason: 'test', capabilities: caps('bmp') });
    expect(renderIndicator('unicode', 0).showVerb).toBe(false);
  });
});
