// src/wxnodus-ui/lib/diffHighlight.ts — diff 语法高亮行分类（纯函数、可单测）
// 输入：diff 正文（```diff 围栏内）；输出：逐行分类——渲染层按类着色
// （add 绿 / del 红 / hunk 青 / meta 灰 / context 正文色），Aider/Claude Code 同款语义。
// 纪律：只分类不渲染——颜色映射留在组件层（主题 token 依赖 t.color）。

export type DiffLineKind = 'add' | 'context' | 'del' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** 摘掉 ```diff/```patch 围栏（宽容读取：无闭合围栏也摘开头——绝不吞内容）。 */
export const stripDiffFence = (text: string): string => {
  const trimmed = text.trim();
  return trimmed
    .replace(/^```(?:diff|patch)[^\n]*\n/, '')
    .replace(/\n```\s*$/, '');
};

// 元行前缀：文件头（diff --git/index/---/+++/模式行/相似度）——注意 ---/+++ 必须先于 +/- 判定
const META_PREFIX = ['diff --git', 'index ', '--- ', '+++ ', 'new file mode', 'deleted file mode', 'similarity index', 'rename from', 'rename to'];

/** diff 正文 → 逐行分类（CRLF 剥离；空行/无前缀归 context）。 */
export const diffLines = (body: string): DiffLine[] => {
  const out: DiffLine[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let kind: DiffLineKind;
    if (line.startsWith('@@')) {
      kind = 'hunk';
    } else if (META_PREFIX.some(p => line.startsWith(p))) {
      kind = 'meta';
    } else if (line.startsWith('+')) {
      kind = 'add';
    } else if (line.startsWith('-')) {
      kind = 'del';
    } else {
      kind = 'context';
    }
    out.push({ kind, text: line });
  }
  return out;
};

/** 高亮行数上限：超限后余行合并单块渲染（内容完整保留，仅着色降级——防超长 diff 节点爆炸）。 */
export const DIFF_HILITE_MAX = 400;
