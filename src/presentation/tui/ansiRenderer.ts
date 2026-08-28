// src/presentation/tui/ansiRenderer.ts — 薄层 TUI 渲染器（P2 / Q1，2026-08-27）
// 设计（V4 L0 输出规范精神——OutputEvent→行序列的纯函数，绝无 React/Ink 依赖）：
//   ① 全部渲染函数为 (输入, 选项) → string 纯函数（零终端副作用，可单测）；
//   ② 语义色单一事实源（与 docs/output-spec-v1.md 同源口径）：accent=动作、error=失败、
//     warn=需注意、muted=元信息、ok 仅终态确认行；
//   ③ colors=false 时输出纯文本（管道/非 TTY 诚实降级，绝无 ANSI 乱码）；
//   ④ 诚实标注文化延续：截断/缓存/合并等标注由内核事件携带，渲染器只着色不改文案。
import { themeTokens, displayWidth, truncateLeft, truncateRight, formatElapsed, formatTokenCount, type ThemeName } from './theme.js';

export interface RenderOpts {
  colors: boolean;
  /** kimi 暗/亮主题（缺省 dark；light 供浅色终端） */
  theme?: ThemeName;
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

/** 回合摘要行：`◦ N 轮 · X tokens · $Y · Zs`（muted 单行；tokens 用紧凑格式 28.5k/1.2m） */
export function renderTurnSummaryLine(parts: { turns?: number; tokens?: number; costUsd?: number; durationMs?: number }, opts: RenderOpts): string {
  const bits: string[] = [];
  if (typeof parts.turns === 'number') bits.push(`${parts.turns} 轮`);
  if (typeof parts.tokens === 'number') bits.push(`${formatTokenCount(parts.tokens)} tokens`);
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

// ── kimi code 风格渲染（2026-08-28：工具行/思考动画/通知/底栏；机制参考 kimi _blocks.py/prompt.py，实现原创）──

/**
 * 工具头行：进行中 "Using Read (path)" → 完成 "Used Read (path)"。
 * kimi 语义：工具名蓝、关键参数灰括号（extract_key_argument 单参数展示）；wxnodus 差异：
 * 行式投影无 spinner bullet（动画留白给思考/生成行），完成态由独立结果行着色（见 renderToolOutcomeLine）。
 */
export function renderToolHeadline(phase: 'start' | 'complete', name: string, keyArg: string, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  const verb = phase === 'start' ? 'Using' : 'Used';
  const namePart = code(opts, t.tool, name);
  const argPart = keyArg ? ` ${code(opts, t.arg, `(${keyArg})`)}` : '';
  return ` ${verb} ${namePart}${argPart}`;
}

/** 工具结果行：绿/红 bullet + 简述（kimi BulletColumns bullet_style=green/dark_red 语义） */
export function renderToolOutcomeLine(ok: boolean, brief: string, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  const bullet = code(opts, ok ? t.ok : t.error, '•');
  const oneLine = brief.replace(/\r?\n/g, ' ').slice(0, 240) + (brief.replace(/\r?\n/g, ' ').length > 240 ? '…' : '');
  return `   ${bullet} ${code(opts, t.arg, oneLine || (ok ? '完成' : '失败'))}`;
}

/** 折叠工具调用计数行（kimi "N more tool calls ..." 语义——行式投影折叠上限外调用） */
export function renderCollapsedToolLine(n: number, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  return `   ${code(opts, t.dim + t.italic, `${n} more tool calls ...`)}`;
}

/**
 * 思考实时行（单行 \r 重绘动画，由调用方循环驱动）：
 * "Thinking" 斜体 + 点动画帧（0.13s×6 帧）+ 耗时 + token 估算 + tok/s 心跳。
 * kimi 语义：默认折叠思考原文、仅记账；结束落 "Thought for Xs · N tokens"（renderThoughtFinal）。
 */
export function renderThinkingLive(input: { tokens: number; elapsedMs: number; frame: string; ratePerSec?: number }, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  const bits = [
    code(opts, t.italic, 'Thinking'),
    code(opts, t.thinkFrame, input.frame),
    ` ${code(opts, t.arg, formatElapsed(input.elapsedMs / 1000))}`,
    ` · ${code(opts, t.arg, `${formatTokenCount(input.tokens)} tokens`)}`,
  ];
  if (typeof input.ratePerSec === 'number' && input.ratePerSec > 0) {
    bits.push(` · ${code(opts, t.arg, `${input.ratePerSec} tok/s`)}`);
  }
  return bits.join('');
}

/** 生成中实时行（spinner 帧 + 耗时 + token 估算；kimi "Composing..." 语义） */
export function renderComposingLive(input: { tokens: number; elapsedMs: number; frame: string }, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  return [
    code(opts, t.info, input.frame),
    ' Composing...',
    ` ${code(opts, t.arg, formatElapsed(input.elapsedMs / 1000))}`,
    ` · ${code(opts, t.arg, `${formatTokenCount(input.tokens)} tokens`)}`,
  ].join('');
}

/** 思考收口一行（灰色斜体——kimi "Thought for Xs · N tokens" 语义） */
export function renderThoughtFinal(input: { tokens: number; elapsedMs: number }, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  return code(opts, t.dim + t.italic, `Thought for ${formatElapsed(input.elapsedMs / 1000)} · ${formatTokenCount(input.tokens)} tokens`);
}

export type NoticeSeverity = 'info' | 'success' | 'warning' | 'error';

const SEVERITY_TOKEN: Record<NoticeSeverity, 'info' | 'ok' | 'warn' | 'error'> = {
  info: 'info', success: 'ok', warning: 'warn', error: 'error',
};

/**
 * 通知块（kimi Notification 语义）：首行=标题加粗着色，正文=灰色预览最多 2 行；
 * 标题取首行、正文取其余——渲染器不猜测 severity（无 level 时默认 info）。
 */
export function renderNotification(severity: NoticeSeverity, text: string, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  const lines = text.split(/\r?\n/);
  const title = lines[0] ?? '';
  const body = lines.slice(1).join('\n').trim();
  const titleLine = code(opts, t.bold + t[SEVERITY_TOKEN[severity]], title);
  if (!body) return titleLine;
  const bodyLines = body.split('\n').slice(0, 2);
  const preview = bodyLines.join('\n') + (body.split('\n').length > 2 ? '\n...' : '');
  return titleLine + '\n' + code(opts, t.arg, preview);
}

export interface ToolbarParts {
  mode: string;
  model?: string;
  /** 思考中圆点（kimi 底栏 ●/○ 语义） */
  thinking?: boolean;
  cwd?: string;
  branch?: string | null;
  flags?: string[];
  /** 会话累计 token（T9：kimi 底栏用量段——渲染为 dim 段，参与窄终端降级链） */
  sessionTokens?: number;
  tip?: string;
  columns?: number;
}

/**
 * 底栏（kimi _render_bottom_toolbar 语义）：分隔线 + 状态行（状态旗标 + 模式(model ●) + cwd 分支徽标 + 轮换提示）；
 * 窄终端优雅降级：全量 → 去提示 → 去分支 → cwd 右截断 → 仅模式名（kimi full→mid→bare 同语义）。
 */
export function renderToolbar(parts: ToolbarParts, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  const columns = Math.max(20, parts.columns ?? 80);
  const sep = code(opts, t.dim, '─'.repeat(columns));

  const segs: Array<{ text: string; styled: string }> = [];
  if (typeof parts.sessionTokens === 'number' && parts.sessionTokens > 0) {
    const tok = `${formatTokenCount(parts.sessionTokens)} tok`;
    segs.push({ text: tok, styled: code(opts, t.dim, tok) });
  }
  const flagSegs = segs.slice(parts.sessionTokens && parts.sessionTokens > 0 ? 1 : 0); // 极窄档只留 flags——token 段随 cwd 一起降级消失
  for (const flag of parts.flags ?? []) {
    const styled = code(opts, t.warn + t.bold, flag);
    segs.push({ text: flag, styled });
  }
  const dot = parts.thinking === true ? '●' : parts.thinking === false ? '○' : '';
  const modeFull = parts.model ? `${parts.mode} (${parts.model} ${dot})`.trim() : parts.mode;
  const modeMid = dot ? `${parts.mode} ${dot}` : parts.mode;
  const cwdText = parts.cwd ? (parts.cwd.replace(/\\/g, '/')) : '';
  const branchSeg = parts.branch ? ` ${parts.branch}` : '';
  const cwdFull = cwdText ? `${cwdText}${branchSeg}` : '';

  const assemble = (mode: string, cwdSeg: string, tip: string | undefined): string => {
    const out: string[] = [];
    for (const s of segs) out.push(s.styled);
    out.push(code(opts, t.info, mode));
    if (cwdSeg) out.push(code(opts, t.arg, cwdSeg));
    if (tip) out.push(code(opts, t.dim, tip));
    return out.join('  ');
  };

  const widthOf = (mode: string, cwdSeg: string, tip: string | undefined): number => {
    let w = segs.reduce((a, s) => a + displayWidth(s.text) + 2, 0);
    w += displayWidth(mode);
    if (cwdSeg) w += 2 + displayWidth(cwdSeg);
    if (tip) w += 2 + displayWidth(tip);
    return w;
  };

  let line = '';
  if (widthOf(modeFull, cwdFull, parts.tip) <= columns) {
    line = assemble(modeFull, cwdFull, parts.tip);
  } else if (widthOf(modeFull, cwdFull, undefined) <= columns) {
    line = assemble(modeFull, cwdFull, undefined);
  } else if (widthOf(modeMid, truncateLeft(cwdText, 30) + (parts.branch ?? ''), undefined) <= columns) {
    line = assemble(modeMid, truncateLeft(cwdText, 30) + (parts.branch ?? ''), undefined);
  } else if (widthOf(modeFull, truncateRight(cwdText, Math.max(0, columns - displayWidth(modeFull) - 8)), undefined) <= columns) {
    line = assemble(modeFull, truncateRight(cwdText, Math.max(0, columns - displayWidth(modeFull) - 8)), undefined);
  } else {
    line = flagSegs.length
      ? [...flagSegs.map(s => s.styled), code(opts, t.info, parts.mode)].join('  ')
      : assemble(parts.mode, '', undefined);
  }
  return `${sep}\n${line}`;
}

// ── T8（2026-08-28）：工具编辑 diff 红绿渲染（kimi 编辑回显视觉）──────────

/** 统一 diff 判定：fs_edit 的 @@ 锚块 / apply_patch 的 diff --git 块 */
export function hasUnifiedDiff(text: string): boolean {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text) || /^diff --git /m.test(text);
}

/**
 * diff 预览渲染：@@ 锚 → info 青、+ 行 → ok 绿、- 行 → error 红、上下文行 → dim；
 * 从 @@/diff --git 进入 diff 态，遇非 diff 行（消息正文/LSP 诊断）收口；
 * 上限 12 行（内核侧 MAX_DIFF_LINES=8 + 锚/省略行余量）。
 * T10（2026-08-28）：相邻 -/+ 配对行做词级高亮——公共前后缀常规色、变更中段加粗
 * （aider/opencode 行内词差语义，实现原创：字符级前后缀剥离，无分词依赖）。
 */
export function renderDiffPreview(text: string, opts: RenderOpts): string {
  const t = themeTokens(opts.theme);
  const out: string[] = [];
  let inDiff = false;
  let delRun: string[] = [];
  const flushRuns = () => {
    if (!delRun.length) return;
    const adds = addRun;
    addRun = [];
    const pairs = Math.min(delRun.length, adds.length);
    for (let i = 0; i < delRun.length; i++) {
      if (i < pairs) out.push(styleInlinePair(`-${delRun[i]!}`, `+${adds[i]!}`, t, opts));
      else out.push(code(opts, t.error, `-${delRun[i]!}`));
    }
    for (let i = pairs; i < adds.length; i++) out.push(code(opts, t.ok, `+${adds[i]!}`));
    delRun = [];
  };
  let addRun: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git')) { flushRuns(); inDiff = true; out.push(code(opts, t.bold, raw)); continue; }
    if (/^@@ /.test(raw)) { flushRuns(); inDiff = true; out.push(code(opts, t.info, raw)); continue; }
    if (!inDiff) continue;
    if (raw.startsWith('+')) { addRun.push(raw.slice(1)); continue; }
    if (raw.startsWith('-')) { if (addRun.length) flushRuns(); delRun.push(raw.slice(1)); continue; }
    if (raw.startsWith(' ')) { flushRuns(); out.push(code(opts, t.dim, raw)); continue; }
    if (raw.startsWith('…')) { flushRuns(); out.push(code(opts, t.dim, raw)); continue; }
    break; // 其他内容（消息/LSP 诊断）——diff 块收口
  }
  flushRuns();
  return out.slice(0, 12).join('\n');
}

/** 字符级公共前后缀剥离（词级高亮的几何基础——纯函数） */
export function splitCommon(a: string, b: string): { pre: string; aMid: string; bMid: string; suf: string } {
  let pre = 0;
  const minLen = Math.min(a.length, b.length);
  while (pre < minLen && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre: a.slice(0, pre), aMid: a.slice(pre, a.length - suf), bMid: b.slice(pre, b.length - suf), suf: a.slice(a.length - suf) };
}

/** -/+ 配对行的词级高亮：符号+公共前后缀常规色、中段加粗（红/绿各按本行色） */
function styleInlinePair(delLine: string, addLine: string, t: ReturnType<typeof themeTokens>, opts: RenderOpts): string {
  const { pre, aMid, bMid, suf } = splitCommon(delLine.slice(1), addLine.slice(1));
  const half = (sign: string, color: string, mid: string, midColor: string) =>
    code(opts, color, sign + pre) + code(opts, midColor, mid) + code(opts, color, suf);
  return half('-', t.error, aMid, t.error + t.bold) + '\n' + half('+', t.ok, bMid, t.ok + t.bold);
}
