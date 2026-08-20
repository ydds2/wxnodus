// src/wxnodus-ui/lib/diffHunks.ts — diff hunk 折叠/应用（supremacy 3.3 / 缺陷 B-02 落地，2026-08-18）
// 机制参考：opencode 双布局 diff hunk 折叠——实现原创（纯函数模型，渲染层消费）。
// 语义（unified diff 契约）：meta 行（文件头）→ 段；@@ 头开启 hunk；hunk 体（含 ± 与上下文）
// 属当前 hunk。折叠单元 = hunk（折叠体保留 @@ 头）或 meta 段（不折叠，信息行）。
// apply 路径：extractPatchText 还原原始补丁文本——UI 交给 agent 的 apply_patch 工具
// （同一补丁来源，不另建应用通道——诚实复用既有结构化补丁）。
import type { DiffLine } from './diffHighlight.js';

export interface DiffHunk {
  /** @@ 头行 */
  header: DiffLine;
  body: DiffLine[];
}

export interface DiffSection {
  /** 文件级元行（diff --git/index/---/+++ 等）与 hunk 前无 @@ 的散行（保守并入，不丢内容） */
  meta: DiffLine[];
  hunks: DiffHunk[];
}

export type FoldSegment =
  | { kind: 'meta'; index: number; lines: DiffLine[] }
  | { kind: 'hunk'; index: number; header: DiffLine; body: DiffLine[]; folded: boolean };

/** 按文件元行分节 → hunk（@@ 头开启新 hunk；hunk 内 +- 与上下文归体） */
export function groupDiffSections(lines: DiffLine[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let curHunk: DiffHunk | null = null;
  for (const line of lines) {
    if (line.kind === 'meta') {
      if (!cur || cur.hunks.length) {
        cur = { meta: [], hunks: [] };
        sections.push(cur);
      }
      cur.meta.push(line);
      curHunk = null;
    } else if (line.kind === 'hunk') {
      if (!cur) { cur = { meta: [], hunks: [] }; sections.push(cur); }
      curHunk = { header: line, body: [] };
      cur.hunks.push(curHunk);
    } else if (curHunk) {
      curHunk.body.push(line);
    } else if (cur) {
      // hunk 前的散行（无 @@ 的手写补丁）——并入 meta 渲染（保守不丢内容）
      cur.meta.push(line);
    }
  }
  return sections;
}

/** 折叠段构建：meta 合并单段（恒展开）；hunk 独立段（默认展开） */
export function buildFoldSegments(lines: DiffLine[]): FoldSegment[] {
  const sections = groupDiffSections(lines);
  const out: FoldSegment[] = [];
  let index = 0;
  for (const sec of sections) {
    if (sec.meta.length) out.push({ kind: 'meta', index: index++, lines: sec.meta });
    for (const h of sec.hunks) out.push({ kind: 'hunk', index: index++, header: h.header, body: h.body, folded: false });
  }
  return out;
}

/** 默认折叠策略：体长 > foldHunkAbove 的 hunk 初始折叠（长 diff 首屏友好——opencode 语义） */
export function withDefaultFolds(segments: FoldSegment[], foldHunkAbove = 20): FoldSegment[] {
  return segments.map(s => (s.kind === 'hunk' && s.body.length > foldHunkAbove ? { ...s, folded: true } : s));
}

/** 切换折叠（meta 段不可折叠原样返回；纯函数不可变） */
export function toggleFold(segments: FoldSegment[], index: number): FoldSegment[] {
  return segments.map((s, i) => {
    if (i !== index || s.kind === 'meta') return s;
    return { ...s, folded: !s.folded };
  });
}

/** 还原原始补丁文本（apply_patch 工具的输入源——与 diffLines 互逆的数据路径） */
export function extractPatchText(lines: DiffLine[]): string {
  return lines.map(l => l.text).join('\n');
}
