// src/kernel/diffText.ts — fs_edit 工具结果的统一 diff 块生成（纯函数、可单测）
// ③ 波 1：编辑类工具结果携带 diff 回显体——UI 端 DiffRenderer 行号 gutter 渲染，
// 模型也能从结果直接看到精确变更（codex verify→RespondToModel 同款「回给模型看变更」）。
// 上限纪律：变更行 ≤ MAX_DIFF_LINES 行/侧、单行 ≤ MAX_LINE_CHARS 字、上下文各 1 行——
// 超限截断显式标注（绝不静默丢行——与 offload/截断诚实口径一致）。
export const MAX_DIFF_LINES = 8;
export const MAX_LINE_CHARS = 120;

const capLine = (s: string): string => {
  const t = s.replace(/\r/g, '');
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t;
};

const capLines = (text: string): { lines: string[]; dropped: number } => {
  const lines = text.replace(/\r/g, '').split('\n').map(capLine);
  if (lines.length <= MAX_DIFF_LINES) return { lines, dropped: 0 };
  return { lines: lines.slice(0, MAX_DIFF_LINES), dropped: lines.length - MAX_DIFF_LINES };
};

export interface UnifiedDiffOpts {
  /** 新文件侧起始行号（1-based，替换落点行） */
  newLine: number;
  oldText: string;
  newText: string;
  /** 替换点前一行原文（空串=文件头/无上下文） */
  before?: string;
  /** 替换点后一行原文（空串=文件尾/无上下文） */
  after?: string;
}

/** 生成统一 diff 块（含 @@ 头与上下文；newLine=0 表示未知——@@ 头行号写 0 让渲染层留空） */
export function renderUnifiedDiff({ newLine, oldText, newText, before, after }: UnifiedDiffOpts): string {
  const old = capLines(oldText);
  const next = capLines(newText);
  const parts: string[] = [];
  parts.push(`@@ -${newLine || 0},${old.lines.length || 1} +${newLine || 0},${next.lines.length || 1} @@`);
  if (before !== undefined && before !== '') parts.push(` ${capLine(before)}`);
  parts.push(...old.lines.map(l => `-${l}`));
  parts.push(...next.lines.map(l => `+${l}`));
  if (old.dropped) parts.push(` …（${old.dropped} 行省略）`);
  if (next.dropped) parts.push(` …（${next.dropped} 行省略）`);
  if (after !== undefined && after !== '') parts.push(` ${capLine(after)}`);
  return parts.join('\n');
}
