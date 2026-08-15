// src/wxnodus-ui/glyphs.test.ts — W8-23：层级感知字形注册表契约
// cmd 变体：无 astral emoji、无盲文、且不得含已确认低覆盖 BMP（✓✗✕☑☐⧉⏎⌛◈❯◉⛶⚙ 等豆腐块风险字）。
// ascii 变体：纯 ASCII。icon() 按运行时层级（getTuiTerminalTier）取变体。
import { afterEach, describe, expect, it } from 'vitest';
import { GLYPHS, icon, translateText, type GlyphId } from './glyphs.js';
import { setTuiTerminalTier } from './lib/terminalTier.js';

const ASTRAL_OR_BRAILLE = /[\u{1F000}-\u{1FAFF}\u{2800}-\u{28FF}]/u;
// 已确认在 Consolas/经典 conhost 字体缺覆盖的 BMP 字形（豆腐块风险）——cmd 变体一律禁用
const LOW_COVERAGE_BMP = /[\u2713\u2717\u2715\u2611\u2610\u29C9\u23CE\u231B\u25C8\u276F\u25C9\u26E6\u2699\u2605\u2606\u2B50\u25C7\u2728\u25CE\u273F]/u;

afterEach(() => { setTuiTerminalTier(null as never); });

describe('W8-23 字形注册表', () => {
  it('每个 id 三变体齐全且非空', () => {
    const ids = Object.keys(GLYPHS) as GlyphId[];
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const def = GLYPHS[id];
      expect(def.modern.length, `${id}.modern`).toBeGreaterThan(0);
      expect(def.cmd.length, `${id}.cmd`).toBeGreaterThan(0);
      expect(def.ascii.length, `${id}.ascii`).toBeGreaterThan(0);
    }
  });

  it('cmd 变体：无 astral emoji、无盲文、无低覆盖 BMP 豆腐块字', () => {
    for (const [id, def] of Object.entries(GLYPHS)) {
      expect(def.cmd, `${id}.cmd 含 astral/盲文`).not.toMatch(ASTRAL_OR_BRAILLE);
      expect(def.cmd, `${id}.cmd 含低覆盖 BMP`).not.toMatch(LOW_COVERAGE_BMP);
    }
  });

  it('ascii 变体：纯 ASCII（0x20–0x7E）', () => {
    for (const [id, def] of Object.entries(GLYPHS)) {
      for (const ch of def.ascii) {
        const code = ch.codePointAt(0)!;
        expect(code, `${id}.ascii 含非 ASCII`).toBeGreaterThanOrEqual(0x20);
        expect(code, `${id}.ascii 含非 ASCII`).toBeLessThanOrEqual(0x7e);
      }
    }
  });

  it('translateText：cmd 档把内嵌 modern 字形替换为层级变体；full 档原样返回', () => {
    expect(translateText('🌟 好运 🔮')).toBe('🌟 好运 🔮');
    setTuiTerminalTier({
      tier: 'cmd',
      reason: 'test',
      capabilities: {
        sync2026: false, decstbm: false, truecolor: false, osc8: false, oscNotify: false,
        mouse: false, extendedKeys: false, glyphSet: 'bmp',
      },
    });
    expect(translateText('🌟 好运 🔮')).toBe('* 好运 ?');
    expect(translateText('●REC 录音中')).toBe('●REC 录音中'); // 长组合先命中，不被 ● 拆坏
  });

  it('icon()：无运行时层级 → modern 变体；cmd 档 → cmd 变体', () => {
    expect(icon('mic')).toBe(GLYPHS.mic.modern);
    setTuiTerminalTier({
      tier: 'cmd',
      reason: 'test',
      capabilities: {
        sync2026: false, decstbm: false, truecolor: false, osc8: false, oscNotify: false,
        mouse: false, extendedKeys: false, glyphSet: 'bmp',
      },
    });
    expect(icon('mic')).toBe(GLYPHS.mic.cmd);
    expect(icon('copy')).toBe(GLYPHS.copy.cmd);
  });
});
