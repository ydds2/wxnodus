// src/wxnodus-ui/lib/terminalTier.test.ts — W8-20：终端能力层级探测（cmd/conhost 风险第一道防线）
// 平台无关纯函数 + 探测结果注入：现代信号 → modern 全量画像；conhost 候选 → 真实探测；
// 探测无应答 → no-vt（绝不输出乱码 TUI）；WXNODUS_TUI_TIER 逃生门。
import { describe, expect, it } from 'vitest';
import { detectTerminalTier } from './terminalTier.js';

const win = { platform: 'win32', tty: true };
const noProbe = async () => { throw new Error('不应触发探测'); };
const MODERN_CAPABILITIES = {
  sync2026: true, decstbm: true, truecolor: true, osc8: true, oscNotify: true,
  mouse: true, extendedKeys: true, glyphSet: 'full',
};

describe('W8-20 terminalTier 层级探测', () => {
  it.each([
    [{ WT_SESSION: 'abc' }],
    [{ TERM_PROGRAM: 'vscode' }],
    [{ MSYSTEM: 'MINGW64' }],
    [{ ConEmuANSI: 'ON' }],
    [{ ANSICON: '1' }],
    [{ TERM: 'xterm-256color' }],
    [{ TERM_PROGRAM: 'mintty' }],
  ])('win32 现代信号 %j → modern 全量画像（零探测）', async (envPatch) => {
    const r = await detectTerminalTier({ ...envPatch } as NodeJS.ProcessEnv, { ...win, probeVt: noProbe });
    expect(r.tier).toBe('modern');
    expect(r.capabilities).toEqual(MODERN_CAPABILITIES);
  });

  it('win32 无现代信号 → 真实探测；VT 应答 + QuickEdit 已关 → cmd 安全画像', async () => {
    const r = await detectTerminalTier({}, { ...win, probeVt: async () => ({ vt: true, quickEditDisabled: true }) });
    expect(r.tier).toBe('cmd');
    expect(r.capabilities).toEqual({
      sync2026: false, decstbm: false, truecolor: false, osc8: false, oscNotify: false,
      mouse: true, extendedKeys: false, glyphSet: 'bmp',
    });
  });

  it('VT 应答但 QuickEdit 未关 → cmd 档鼠标保守关闭（绝不假装可用）', async () => {
    const r = await detectTerminalTier({}, { ...win, probeVt: async () => ({ vt: true, quickEditDisabled: false }) });
    expect(r.tier).toBe('cmd');
    expect(r.capabilities.mouse).toBe(false);
  });

  it('探测无应答 → no-vt（绝不输出乱码 TUI）', async () => {
    const r = await detectTerminalTier({}, { ...win, probeVt: async () => false });
    expect(r.tier).toBe('no-vt');
    expect(r.capabilities.glyphSet).toBe('ascii');
    expect(r.capabilities.sync2026).toBe(false);
  });

  it('非 TTY 与 TERM=dumb → no-vt（fail-closed）', async () => {
    expect((await detectTerminalTier({}, { ...win, tty: false, probeVt: noProbe })).tier).toBe('no-vt');
    expect((await detectTerminalTier({ TERM: 'dumb' }, { platform: 'linux', tty: true })).tier).toBe('no-vt');
  });

  it('非 Windows 平台 → modern（xterm 生态，不做 conhost 探测）', async () => {
    const r = await detectTerminalTier({}, { platform: 'linux', tty: true, probeVt: noProbe });
    expect(r.tier).toBe('modern');
  });

  it.each(['modern', 'cmd', 'no-vt'] as const)('WXNODUS_TUI_TIER=%s 逃生门覆盖', async (tier) => {
    const r = await detectTerminalTier({ WXNODUS_TUI_TIER: tier }, { ...win, probeVt: noProbe });
    expect(r.tier).toBe(tier);
  });
});
