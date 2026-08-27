// src/presentation/tui/ansiRenderer.ts — 薄层 TUI 渲染器（P2 / Q1，2026-08-27）
// 设计（V4 L0 输出规范精神——OutputEvent→行序列的纯函数，绝无 React/Ink 依赖）：
//   ① 全部渲染函数为 (输入, 选项) → string 纯函数（零终端副作用，可单测）；
//   ② 语义色单一事实源（与 docs/output-spec-v1.md 同源口径）：accent=动作、error=失败、
//     warn=需注意、muted=元信息、ok 仅终态确认行；
//   ③ colors=false 时输出纯文本（管道/非 TTY 诚实降级，绝无 ANSI 乱码）；
//   ④ 诚实标注文化延续：截断/缓存/合并等标注由内核事件携带，渲染器只着色不改文案。
export interface RenderOpts {
  colors: boolean;
}

const code = (opts: RenderOpts, open: string, text: string, close = '\x1b[0m'): string =>
  opts.colors ? `${open}${text}${close}` : text;

export const COLORS = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  accent: '\x1b[36m', // cyan
  error: '\x1b[31m', // red
  warn: '\x1b[33m', // yellow
  ok: '\x1b[32m', // green
  muted: '\x1b[90m', // bright black
} as const;

/** 用户输入行：`❯ 文本`（长输入折叠） */
export function renderUserLine(text: string, opts: RenderOpts): string {
  const shown = text.length > 500 ? `${text.slice(0, 500)}…[长消息已折叠 ${text.length} 字]` : text;
  return `${code(opts, COLORS.muted, '❯')} ${shown}`;
}

/** 工具开始行：`⏺ 工具名 参数摘要`（进行中语义） */
export function renderToolStartLine(name: string, argsSummary: string, opts: RenderOpts): string {
  const summary = argsSummary ? ` ${argsSummary}` : '';
  return `${code(opts, COLORS.accent, '⏺')} ${code(opts, COLORS.accent, name)}${summary}`;
}

export type ToolOutcome = 'ok' | 'failed' | 'denied' | 'cached' | 'timeout';

const OUTCOME_COLOR: Record<ToolOutcome, string> = {
  ok: COLORS.muted,
  failed: COLORS.error,
  denied: COLORS.warn,
  cached: COLORS.muted,
  timeout: COLORS.warn,
};
const OUTCOME_GLYPH: Record<ToolOutcome, string> = {
  ok: '⎿',
  failed: '⎿',
  denied: '⎿',
  cached: '⟳',
  timeout: '⏱',
};

/** 工具结果行：`⎿ 预览`（outcome 语义色——结构化结局决定着色，绝无正则猜测） */
export function renderToolResultLine(outcome: ToolOutcome, preview: string, opts: RenderOpts): string {
  const glyph = OUTCOME_GLYPH[outcome];
  const oneLine = preview.replace(/\r?\n/g, ' ').slice(0, 240) + (preview.replace(/\r?\n/g, ' ').length > 240 ? '…' : '');
  return ` ${code(opts, OUTCOME_COLOR[outcome], glyph)} ${code(opts, OUTCOME_COLOR[outcome], oneLine || '（无输出）')}`;
}

/** 系统通知行：`◈ 文本`（level 语义色） */
export function renderNoticeLine(text: string, level: 'info' | 'warn' | 'error', opts: RenderOpts): string {
  const color = level === 'error' ? COLORS.error : level === 'warn' ? COLORS.warn : COLORS.muted;
  return `${code(opts, color, '◈')} ${code(opts, color, text)}`;
}

/** 思考流：折叠标题（终端版只显首行 token 计数占位） */
export function renderReasoningLine(tokens: number, opts: RenderOpts): string {
  return code(opts, COLORS.muted, `▸ 推理 (${tokens} tokens)`);
}

/** 回合摘要行：`◦ N 轮 · X tokens · $Y · Zs`（muted 单行） */
export function renderTurnSummaryLine(parts: { turns?: number; tokens?: number; costUsd?: number; durationMs?: number }, opts: RenderOpts): string {
  const bits: string[] = [];
  if (typeof parts.turns === 'number') bits.push(`${parts.turns} 轮`);
  if (typeof parts.tokens === 'number') bits.push(`${parts.tokens} tokens`);
  if (typeof parts.costUsd === 'number') bits.push(`$${parts.costUsd.toFixed(4)}`);
  if (typeof parts.durationMs === 'number') bits.push(`${(parts.durationMs / 1000).toFixed(1)}s`);
  if (!bits.length) return '';
  return code(opts, COLORS.muted, `◦ ${bits.join(' · ')}`);
}

/** 终态行：`✓ 完成` / `✗ 失败（终态）`——ok 仅用于终态确认行 */
export function renderFinalLine(status: string, okFlag: boolean, opts: RenderOpts): string {
  const color = okFlag ? COLORS.ok : COLORS.error;
  const glyph = okFlag ? '✓' : '✗';
  return code(opts, color, `${glyph} ${okFlag ? '完成' : `结束（${status}）`}`);
}

/** 启动横幅（简洁三行——模型/命令/退出提示） */
export function renderBanner(model: string, opts: RenderOpts): string {
  return [
    code(opts, COLORS.accent, 'WxNodus 交互模式（薄层 TUI）'),
    code(opts, COLORS.muted, ` 模型：${model} · / 开头为命令 · /exit 退出 · 空行跳过`),
    '',
  ].join('\n');
}
