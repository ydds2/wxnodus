// src/wxnodus-ui/lib/motion.ts — 黑洞主题动效帧生成器（纯函数、确定性、可单测）
// 纪律：只输出字符/颜色（单格 damage 差分可承载）；动效档位三级：
//   full   → 全部帧动画（modern 终端）
//   subtle → 仅低开销呼吸色（cmd/conhost——字形集受限，旋转环/星尘降级）
//   off    → 零动画（no-vt 行模式 / WXNODUS_NO_ANIM=1 显式关闭）
// 所有帧函数为 (i, …) 纯函数：同参同帧，跨渲染循环可重复比对（diff 友好）。
import { getTuiTerminalTier, type TerminalTier } from './terminalTier.js';

export type MotionTier = 'full' | 'subtle' | 'off';

/** 可注入判定（测试/渲染器直通）：tier 来自 terminalTier 探测，noAnim 来自环境开关。 */
export function motionTierFor(tier: TerminalTier | null | undefined, noAnim: boolean): MotionTier {
  if (noAnim) return 'off';
  if (tier === 'no-vt') return 'off';
  if (tier === 'cmd') return 'subtle';
  return 'full';
}

/** 运行时档位：WXNODUS_NO_ANIM=1 强制 off；否则按终端能力探测降级。 */
export function motionTier(): MotionTier {
  const t = getTuiTerminalTier();
  return motionTierFor(t?.tier ?? null, process.env.WXNODUS_NO_ANIM === '1');
}

const RING = ['◐', '◓', '◑', '◒'];
const RING_ASCII = ['|', '/', '-', '\\'];

/** 吸积盘：4 帧旋转环 + 中心黑洞脉动（帧序列确定性；ascii 变体供 subtle 档）。 */
export function accretionRing(i: number, ascii = false): string[] {
  const phase = ((i % 4) + 4) % 4;
  const ring = ascii ? RING_ASCII : RING;
  const core = i % 2 === 0 ? '●' : '◉';
  const frame = `${ring[phase]} ${core} ${ring[(phase + 2) % 4]}`;
  if (ascii) return [frame];
  return [frame, `  ╭─${core}─╮  `];
}

/** 超新星：0..4 帧爆发→消散，i>=5 空（完成庆祝一次性动画，播完即静止）。 */
export function supernova(i: number): string {
  const frames = ['✦', '✦ ✧ ✦', '✧ ✦ ✧ ✦ ✧', '✦ ✧ ✦', '· ✦ ·', ''];
  return frames[i] ?? '';
}

/** 星尘：确定性伪随机游走（种子+帧号），输出 `列:字符` 稀疏点对供定位渲染。 */
export function starfield(i: number, cols: number, seed = 7): string {
  const chars = ['·', '✦', '·', '·', '✧'];
  const width = Math.max(1, Math.floor(cols || 1));
  const out: string[] = [];
  let x = (seed * 31 + i * 17) % width;
  for (let n = 0; n < 5; n++) {
    x = (x * 37 + 13) % width;
    out.push(`${x}:${chars[(seed + i + n) % chars.length]}`);
  }
  return out.join(' ');
}

/** 呼吸：256 色灰阶脉动（232..255 合法 ansi256 色号，low 开销——subtle 档唯一保留的动效）。 */
export function breatheColor(i: number): string {
  const v = 232 + (((i % 24) + 24) % 24);
  return `ansi256(${v})`;
}

/** 工具拟态·字符雨（bash 执行时）：帧内伪随机列下落，列号不越界（cols 小则空串）。 */
export function toolRain(i: number, cols: number): string {
  const glyphs = ['│', '┃', '┆', '┊', '┋'];
  const width = Math.max(0, Math.floor(cols || 0));
  const out: string[] = [];
  for (let c = 0; c < width - 1 && c < 40; c += 3) {
    const h = (c * 7 + i * 5) % 6;
    if (h < 3) out.push(`${Math.min(width - 1, c + (i % 3))}:${glyphs[(c + i) % glyphs.length]}`);
  }
  return out.join(' ');
}
