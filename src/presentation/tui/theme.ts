// src/presentation/tui/theme.ts — 薄层 TUI 主题与文本度量（kimi code 风格化，2026-08-28）
// 机制参考：kimi-cli ui/theme.py（暗/亮主题集中令牌 + 语义色单一事实源）、
//          ui/shell/prompt.py:_display_width/_truncate_left/_truncate_right（CJK 显示宽度截断）、
//          ui/shell/visualize/_blocks.py:_bullet_frame_for/_estimate_tokens、
//          utils/datetime.py:format_elapsed、soul.format_token_count——实现全部原创：
//   - 无 rich/prompt_toolkit 依赖：ANSI 令牌 + 自实现宽字符表（East Asian Wide/Fullwidth + 零宽字符跳过）；
//   - 主题开关为纯函数参数（dark 默认；light 供浅色终端），不引入全局可变状态。
export type ThemeName = 'dark' | 'light';

export interface ThemeTokens {
  /** 分隔线 / 淡出文本 */
  dim: string;
  /** 工具名（kimi "Used Read" 的工具名蓝） */
  tool: string;
  /** 参数/元信息灰 */
  arg: string;
  /** 成功 */
  ok: string;
  /** 失败（kimi dark_red 语义） */
  error: string;
  /** 警告 */
  warn: string;
  /** 信息 */
  info: string;
  /** 主强调 */
  accent: string;
  /** 思考动画帧 */
  thinkFrame: string;
  /** 斜体 */
  italic: string;
  /** 粗体 */
  bold: string;
  /** 重置 */
  reset: string;
}

const _DARK: ThemeTokens = {
  dim: '\x1b[90m',      // bright black（kimi grey50 等价）
  tool: '\x1b[34m',     // blue（kimi "Used <tool>" 工具名蓝）
  arg: '\x1b[90m',      // grey50
  ok: '\x1b[32m',       // green
  error: '\x1b[31m',    // red（kimi dark_red 深红近似）
  warn: '\x1b[33m',     // yellow
  info: '\x1b[36m',     // cyan（kimi notification info）
  accent: '\x1b[36m',   // cyan
  thinkFrame: '\x1b[36m',
  italic: '\x1b[3m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

const _LIGHT: ThemeTokens = {
  dim: '\x1b[90m',
  tool: '\x1b[34m',
  arg: '\x1b[90m',
  ok: '\x1b[32m',
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  accent: '\x1b[36m',
  thinkFrame: '\x1b[36m',
  italic: '\x1b[3m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

export function themeTokens(theme: ThemeName = 'dark'): ThemeTokens {
  return theme === 'light' ? _LIGHT : _DARK;
}

// ── 显示宽度（CJK/全角=2 列，零宽=0，组合标记=0）────────────────────────────
const ZERO_WIDTH = new Set<number>([
  0x0300, 0x034f, 0x200b, 0x200c, 0x200d, 0xfeff, 0xfe0f,
]);

/** 单字符终端列宽（近似 wcwidth；East Asian Wide/Fullwidth=2，控制符=0） */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp === 0 || ZERO_WIDTH.has(cp)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // 组合变音符号
  if (
    (cp >= 0x1100 && cp <= 0x115f)   // Hangul Jamo
    || cp === 0x2329 || cp === 0x232a // 〈 〉
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) // CJK 部首…彝文
    || (cp >= 0xac00 && cp <= 0xd7a3) // 谚文音节
    || (cp >= 0xf900 && cp <= 0xfaff) // CJK 兼容
    || (cp >= 0xfe10 && cp <= 0xfe19) // 竖排标点
    || (cp >= 0xfe30 && cp <= 0xfe6f) // CJK 兼容形式
    || (cp >= 0xff00 && cp <= 0xff60) // 全角
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x2600 && cp <= 0x27bf) // 杂项符号/装饰符（✅ 等）
    || (cp >= 0x1f000 && cp <= 0x1faff) // emoji/符号/麻将牌
    || (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) return 2;
  return 1;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

const ELLIPSIS = '…';

/** 右侧截断：超出 maxCols 时尾部加 …（kimi _truncate_right 语义，CJK 感知） */
export function truncateRight(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  if (displayWidth(text) <= maxCols) return text;
  const budget = maxCols - displayWidth(ELLIPSIS);
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ELLIPSIS;
}

/** 左侧截断：超出 maxCols 时头部加 …（kimi _truncate_left 语义，CJK 感知） */
export function truncateLeft(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  if (displayWidth(text) <= maxCols) return text;
  const budget = maxCols - displayWidth(ELLIPSIS);
  const chars = [...text];
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]);
    if (w + cw > budget) break;
    out = chars[i] + out;
    w += cw;
  }
  return ELLIPSIS + out;
}

// ── 数字格式化（kimi 语义）───────────────────────────────────────────────
/** 耗时紧凑格式：<1s / 5s / 1m 30s / 1h 1m 1s（kimi utils/datetime.format_elapsed 语义） */
export function formatElapsed(seconds: number): string {
  if (seconds < 1) return '<1s';
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  return `${minutes}m ${secs}s`;
}

/** token 计数紧凑格式：28.5k / 128k / 1.2m（kimi soul.format_token_count 语义） */
export function formatTokenCount(n: number): string {
  const int = Math.max(0, Math.floor(n));
  if (int >= 1_000_000) return `${_compact(int / 1_000_000)}m`;
  if (int >= 1_000) return `${_compact(int / 1_000)}k`;
  return String(int);
}

function _compact(value: number): string {
  const s = value.toFixed(1).replace(/\.0$/, '');
  return s;
}

/** 混合 CJK/Latin 文本 token 估算（kimi _estimate_tokens 语义：CJK≈1.5/字，Latin≈1/4 字；浮点累积防小块截断） */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff)
      || (cp >= 0x3400 && cp <= 0x4dbf)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0x3000 && cp <= 0x303f)
      || (cp >= 0xff00 && cp <= 0xffef)
    ) cjk++;
    else other++;
  }
  return cjk * 1.5 + other / 4;
}

// ── 动画帧（kimi _blocks.py 语义：6 帧 0.13s 循环 + 经典点阵 spinner）─────
/** Thinking 后接的点动画帧（".  ",".. ","..."," ..","  .","   "——0.13s/帧，墙上时钟选帧） */
export const THINK_BULLET_FRAMES = ['.  ', '.. ', '...', ' ..', '  .', '   '] as const;
export const THINK_BULLET_INTERVAL_MS = 130;

export function thinkBulletFrameAt(nowMs: number): string {
  const idx = Math.floor(nowMs / THINK_BULLET_INTERVAL_MS) % THINK_BULLET_FRAMES.length;
  return THINK_BULLET_FRAMES[idx];
}

/** 经典点阵 spinner 帧（Composing 用；80ms/帧） */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const SPINNER_INTERVAL_MS = 80;

export function spinnerFrameAt(nowMs: number): string {
  return SPINNER_FRAMES[Math.floor(nowMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
}

/** 全局（clamp 到零） */
export function elapsedSec(startMs: number, nowMs: number = Date.now()): number {
  return Math.max(0, (nowMs - startMs) / 1000);
}
