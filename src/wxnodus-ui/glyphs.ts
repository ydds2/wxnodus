// src/wxnodus-ui/glyphs.ts — W8-23：层级感知字形注册表（cmd/conhost 风险第四道防线）
// 所有 UI 图标/符号经 icon(id) 取层级变体——组件不再硬编码 emoji/盲文。
// modern：现状全量（含 astral emoji/盲文）；cmd：BMP 安全集（无 astral/无盲文/无低覆盖 BMP）；
// ascii：纯 ASCII（Tier 0 备用）。层级来源：getTuiTerminalTier()（CLI 引导写入），缺省 full。
import { getTuiTerminalTier } from './lib/terminalTier.js';

export interface GlyphDef {
  modern: string;
  cmd: string;
  ascii: string;
}

export const GLYPHS = {
  brand: { modern: '◉', cmd: '◆', ascii: 'O' },
  prompt: { modern: '✨', cmd: '>', ascii: '>' }, // kimi PROMPT_SYMBOL 对齐
  tool: { modern: '┊', cmd: '│', ascii: '|' },
  // 2026-08-19 工具调用行前缀（对标 Claude Code ⏺ / Codex 同族）
  toolCall: { modern: '⏺', cmd: '•', ascii: '*' },
  mic: { modern: '🎤', cmd: '●', ascii: '[R]' },
  rec: { modern: '●REC', cmd: '●REC', ascii: '[REC]' },
  battery: { modern: '⚡', cmd: '⚡', ascii: '!' },
  batteryLow: { modern: '◌', cmd: 'o', ascii: 'o' },
  copy: { modern: '⧉', cmd: '[copy]', ascii: '[copy]' },
  lock: { modern: '🔐', cmd: '[*]', ascii: '[*]' },
  key: { modern: '🔑', cmd: '[*]', ascii: '[*]' },
  warn: { modern: '⚠', cmd: '!', ascii: '!' },
  check: { modern: '✓', cmd: '√', ascii: 'v' },
  cross: { modern: '✗', cmd: '×', ascii: 'x' },
  close: { modern: '✕', cmd: '×', ascii: 'x' },
  circleF: { modern: '●', cmd: '●', ascii: '*' },
  circleO: { modern: '○', cmd: '○', ascii: 'o' },
  squareF: { modern: '■', cmd: '■', ascii: '#' },
  hourglass: { modern: '⌛', cmd: '~', ascii: '~' },
  expand: { modern: '▾', cmd: 'v', ascii: 'v' },
  submit: { modern: '⏎', cmd: 'Enter', ascii: 'Enter' },
  diamond: { modern: '◈', cmd: '◆', ascii: '*' },
  target: { modern: '🎯', cmd: '@', ascii: '@' },
  sparkles: { modern: '🌟', cmd: '*', ascii: '*' },
  crystal: { modern: '🔮', cmd: '?', ascii: '?' },
  starF: { modern: '★', cmd: '*', ascii: '*' },
  starO: { modern: '☆', cmd: '*', ascii: 'o' },
  taskDone: { modern: '☑', cmd: '[x]', ascii: '[x]' },
  taskOpen: { modern: '☐', cmd: '[ ]', ascii: '[ ]' },
  bullet: { modern: '•', cmd: '·', ascii: '-' },
  gear: { modern: '⚙', cmd: '+', ascii: '+' },
  fullscreen: { modern: '⛶', cmd: '[]', ascii: '[]' },
  dash: { modern: '−', cmd: '-', ascii: '-' },
  arrowRight: { modern: '→', cmd: '->', ascii: '->' },
  circleCheck: { modern: '✅', cmd: '√', ascii: 'OK' },
  squareFill: { modern: '⬛', cmd: '■', ascii: '#' },
  folder: { modern: '📁', cmd: '[D]', ascii: '[D]' },
  satellite: { modern: '🛰', cmd: '~', ascii: '~' },
  fire: { modern: '🔥', cmd: '^', ascii: '^' },
} as const satisfies Record<string, GlyphDef>;

export type GlyphId = keyof typeof GLYPHS;

export function icon(id: GlyphId): string {
  const def = GLYPHS[id];
  const glyphSet = getTuiTerminalTier()?.capabilities.glyphSet ?? 'full';
  if (glyphSet === 'bmp') return def.cmd;
  if (glyphSet === 'ascii') return def.ascii;
  return def.modern;
}

/** 整段文本降级：把内嵌的 modern 字形替换为当前层级变体（fortune/提示文本等自由文案）。
 *  按 modern 长度降序替换，避免短字面量先命中长组合（如 ●REC 中的 ●）。 */
export function translateText(text: string): string {
  const glyphSet = getTuiTerminalTier()?.capabilities.glyphSet ?? 'full';
  if (glyphSet === 'full') return text;
  const entries = Object.entries(GLYPHS).sort((a, b) => b[1].modern.length - a[1].modern.length);
  let out = text;
  for (const [, def] of entries) {
    out = out.split(def.modern).join(glyphSet === 'bmp' ? def.cmd : def.ascii);
  }
  return out;
}
