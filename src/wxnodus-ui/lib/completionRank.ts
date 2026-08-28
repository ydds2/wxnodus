// src/wxnodus-ui/lib/completionRank.ts — @补全排序与接受语义（波 2 ② 7→8，纯函数可单测）
// crush internal/ui/completions/completions.go:205-260 分层排序（basename 精确 > basename
// 前缀 > 任意路径段前缀 > 包含）+ opencode prompt/frecency.tsx:10-42（frecency 权重）+
// kimi prompt.py:1276-1290（enter 双语义：slash 接受即提交）。
export type CompletionKind = 'slash' | 'path' | 'agent'

export interface RankableItem {
  display: string
  text?: string
  meta?: string
  kind?: CompletionKind
}

const basenameOf = (display: string): string => {
  const i = Math.max(display.lastIndexOf('/'), display.lastIndexOf('\\'))
  return i < 0 ? display : display.slice(i + 1)
}

const segmentsOf = (display: string): string[] => display.split(/[/\\]/)

/** 分层排序（crush 对标）：0 basename 精确 = 1 basename 前缀 = 2 display 前缀 =
 *  3 路径段前缀 = 4 包含 = 5 不匹配（保序）。层内保持输入顺序（稳定）。 */
export function rankCompletions<T extends RankableItem>(items: T[], prefix: string): T[] {
  const p = prefix.toLowerCase()
  const layerOf = (it: T): number => {
    const d = it.display.toLowerCase()
    const base = basenameOf(d)
    if (base === p) return 0
    if (base.startsWith(p)) return 1
    if (d.startsWith(p)) return 2
    if (segmentsOf(d).some(s => s.startsWith(p))) return 3
    if (d.includes(p)) return 4
    return 5
  }
  return [...items]
    .map((it, i) => ({ it, i, layer: layerOf(it) }))
    .sort((a, b) => a.layer - b.layer || a.i - b.i)
    .map(x => x.it)
}

/** frecency 权重（opencode 对标）：frecency 降序稳定重排——使用越频越靠前；
 *  未记录（0）项保持相对顺序垫底（gateway 分层结果作为次优兜底）。 */
export function withFrecency<T extends RankableItem>(items: T[], frecency: Map<string, number>): T[] {
  return [...items]
    .map((it, i) => ({ it, i, f: frecency.get(it.text ?? it.display) ?? 0 }))
    .sort((a, b) => b.f - a.f || a.i - b.i)
    .map(x => x.it)
}

/** enter 双语义（kimi prompt.py:1276-1290 对标）：
 *  slash 补全接受 = 替换为完整命令并立即提交；path/agent 接受 = 只替换 token 不提交。 */
export function completionEnterAction(
  kind: CompletionKind | undefined,
  itemText: string,
  input: string,
  replaceFrom: number,
): { next: string; submit: boolean } {
  if (kind === 'slash') return { next: itemText, submit: true }
  const text = input.startsWith('/') && itemText.startsWith('/') && replaceFrom > 0 ? itemText.slice(1) : itemText
  return { next: input.slice(0, replaceFrom) + text, submit: false }
}
