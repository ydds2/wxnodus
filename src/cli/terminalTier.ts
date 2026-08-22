// src/wxnodus-ui/lib/terminalTier.ts — W8-20：终端能力层级探测（cmd/conhost 风险第一道防线）
// 三级画像：modern（全量）/ cmd（conhost VT 已开，安全画像）/ no-vt（绝不出乱码，行模式诚实降级）。
// 纯函数 + 探测注入（平台无关可测）；探测缺省 fail-closed（绝不假设 VT 可用）。
export type TerminalTier = 'modern' | 'cmd' | 'no-vt';

export interface TerminalCapabilities {
  /** DEC 2026 同步输出（BSU/ESU）——conhost 不支持 */
  sync2026: boolean;
  /** DECSTBM 滚动区域硬件滚动——conhost 不支持 */
  decstbm: boolean;
  /** 24 位真彩 SGR——conhost 老版本不支持，收敛 256 色 */
  truecolor: boolean;
  /** OSC 8 超链接 */
  osc8: boolean;
  /** OSC 52 剪贴板发射；false 时仍可使用 clip.exe 等本机路径 */
  clipboard: boolean;
  /** OSC 9/99/777/21337 通知/进度/tab——conhost 不支持（标题走 process.title） */
  oscNotify: boolean;
  /** 鼠标跟踪可用（cmd 需 QuickEdit 已关） */
  mouse: boolean;
  /** Kitty 键盘协议/modifyOtherKeys 扩展键 */
  extendedKeys: boolean;
  /** 字形集：full（emoji+盲文）/ bmp（无 astral 无盲文）/ ascii */
  glyphSet: 'full' | 'bmp' | 'ascii';
}

export interface TerminalTierResult {
  tier: TerminalTier;
  capabilities: TerminalCapabilities;
  reason: string;
}

// ── 运行时层级槽（CLI 引导后写入，渲染器能力注入读取）──
let runtimeTier: TerminalTierResult | null = null;
export function setTuiTerminalTier(result: TerminalTierResult): void { runtimeTier = result; }
export function getTuiTerminalTier(): TerminalTierResult | null { return runtimeTier; }

// ── 渲染器能力映射（ink RendererCapabilities 的结构子集——字段同名，结构类型直通）──
export interface RendererCapabilityMap {
  sync2026: boolean;
  decstbm: boolean;
  truecolor: boolean;
  osc8: boolean;
  clipboard: boolean;
  oscNotify: boolean;
  mouse: boolean;
  extendedKeys: boolean;
}
export function rendererCapabilitiesFor(result: TerminalTierResult): RendererCapabilityMap {
  const c = result.capabilities;
  return {
    sync2026: c.sync2026, decstbm: c.decstbm, truecolor: c.truecolor, osc8: c.osc8,
    clipboard: c.clipboard, oscNotify: c.oscNotify, mouse: c.mouse, extendedKeys: c.extendedKeys,
  };
}

export type VtProbeResult = boolean | { vt: boolean; quickEditDisabled?: boolean };

export interface TerminalTierOptions {
  platform?: string;
  tty?: boolean;
  /** conhost 的 VT 输出位回读；缺省 fail-closed → no-vt */
  probeVt?: () => VtProbeResult | Promise<VtProbeResult>;
}

const MODERN_TERM_PROGRAMS = new Set([
  'vscode', 'Cursor', 'Windsurf', 'WezTerm', 'iTerm.app', 'ghostty',
  'contour', 'alacritty', 'WarpTerminal', 'mintty',
]);

const modernCapabilities = (): TerminalCapabilities => ({
  sync2026: true, decstbm: true, truecolor: true, osc8: true, clipboard: true, oscNotify: true,
  mouse: true, extendedKeys: true, glyphSet: 'full',
});

const cmdCapabilities = (mouse: boolean): TerminalCapabilities => ({
  sync2026: false, decstbm: false, truecolor: false, osc8: false, clipboard: false, oscNotify: false,
  mouse, extendedKeys: false, glyphSet: 'bmp',
});

const noVtCapabilities = (): TerminalCapabilities => ({
  sync2026: false, decstbm: false, truecolor: false, osc8: false, clipboard: false, oscNotify: false,
  mouse: false, extendedKeys: false, glyphSet: 'ascii',
});

const modernReason = (env: NodeJS.ProcessEnv): string => {
  if (env.WT_SESSION) return 'WT_SESSION（Windows Terminal）';
  if (env.TERM_PROGRAM) return `TERM_PROGRAM=${env.TERM_PROGRAM}`;
  if (env.MSYSTEM) return `MSYSTEM=${env.MSYSTEM}（mintty）`;
  if (env.ConEmuANSI || env.ConEmuPID || env.ConEmuTask) return 'ConEmuANSI（ConEmu）';
  if (env.ANSICON) return 'ANSICON';
  return `TERM=${env.TERM}`;
};

export async function detectTerminalTier(
  env: NodeJS.ProcessEnv = process.env,
  options: TerminalTierOptions = {},
): Promise<TerminalTierResult> {
  const override = env.WXNODUS_TUI_TIER;
  if (override === 'modern') return { tier: 'modern', capabilities: modernCapabilities(), reason: 'WXNODUS_TUI_TIER=modern（逃生门）' };
  if (override === 'cmd') return { tier: 'cmd', capabilities: cmdCapabilities(false), reason: 'WXNODUS_TUI_TIER=cmd（逃生门，无探测——鼠标保守关闭）' };
  if (override === 'no-vt') return { tier: 'no-vt', capabilities: noVtCapabilities(), reason: 'WXNODUS_TUI_TIER=no-vt（逃生门）' };

  const tty = options.tty ?? Boolean(process.stdout?.isTTY);
  if (!tty) return { tier: 'no-vt', capabilities: noVtCapabilities(), reason: 'stdout 非 TTY' };
  if ((env.TERM ?? '') === 'dumb') return { tier: 'no-vt', capabilities: noVtCapabilities(), reason: 'TERM=dumb（无光标寻址能力）' };

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { tier: 'modern', capabilities: modernCapabilities(), reason: '非 Windows（xterm 生态，不做 conhost 探测）' };

  // Windows：现代终端信号 → modern；否则 conhost 候选 → 真实 VT 探测（CPR）
  const term = env.TERM ?? '';
  const modernSignal = Boolean(env.WT_SESSION)
    || MODERN_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? '')
    || Boolean(env.MSYSTEM)
    || Boolean(env.ConEmuANSI) || Boolean(env.ConEmuPID) || Boolean(env.ConEmuTask)
    || Boolean(env.ANSICON)
    || /^(xterm|screen|tmux|rxvt|alacritty|kitty|ghostty)/.test(term);
  if (modernSignal) return { tier: 'modern', capabilities: modernCapabilities(), reason: modernReason(env) };

  const probe = options.probeVt ?? (async () => false);
  const probed: VtProbeResult = await probe();
  const result = typeof probed === 'boolean' ? { vt: probed } : probed;
  if (!result.vt) {
    return { tier: 'no-vt', capabilities: noVtCapabilities(), reason: 'conhost VT 位未置位（VT 未开启或老于 1511）' };
  }
  return { tier: 'cmd', capabilities: cmdCapabilities(result.quickEditDisabled === true), reason: 'conhost（VT 已开启，cmd 安全画像）' };
}
