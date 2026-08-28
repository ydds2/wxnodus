// src/wxnodus-ui/lib/diffGutter.ts — diff 行号排水沟 + diff 体检测（纯函数、可单测）
// gemini DiffRenderer.tsx:224-399 移植要点：行号 gutter 由 @@ 头驱动——hunk 内按新文件侧
// 行号逐行排布（del 行不占新文件行号），hunk 外与折叠段行号留空（渲染层画空白）。

/** 统一 diff 行分类（与 diffHighlight.DiffLine 结构兼容的最小端口） */
export interface GutterLine { kind: 'add' | 'context' | 'del' | 'hunk' | 'meta'; text: string }

/** 逐行新侧行号（git 右侧排水沟语义）：`@@ -a[,b] +c[,d] @@` 头 → +c 起算；
 *  del 行在新文件不存在 → 右侧留空（null）且不递增；context/add 占行号并递增；hunk 外 null */
export const lineNumbersFor = (lines: GutterLine[]): Array<number | null> => {
  const out: Array<number | null> = [];
  let cur: number | null = null;
  for (const l of lines) {
    if (l.kind === 'hunk') {
      const m = l.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      cur = m ? Number(m[1]) : cur;
      out.push(null);
      continue;
    }
    if (cur === null) { out.push(null); continue; }
    if (l.kind === 'del') { out.push(null); continue; } // 新文件无此行——右侧留空
    out.push(cur);
    cur += 1;
  }
  return out;
};

/** 是否含统一 diff hunk 头（`@@ -` 起首才认——避免把普通文本里的 @ 当作 diff） */
export const hasDiffHunks = (text: string): boolean => /^@@ -\d/.test(text.trim()) || /\n@@ -\d/.test(text);

/**
 * 提取文本尾部的 diff 体（工具结果/正文混排检测）：
 * 第一个 `@@ -` hunk 头起、且其后确有 +/- 变更行 → 返回 diff 体；否则 null。
 * 双条件（hunk 头 + 变更行）防御 grep 输出等恰好含「@@ -」字样的普通文本误判。
 */
export const diffBodyOf = (text: string): string | null => {
  const m = text.match(/(?:^|\n)(?=@@ -\d)/);
  if (!m || m.index === undefined) return null;
  const start = m.index + (text[m.index] === '\n' ? 1 : 0); // @@ 行首
  const body = text.slice(start);
  const tailLines = body.split('\n').slice(1);
  if (!tailLines.some(l => /^[+-]/.test(l))) return null;
  return body;
};
