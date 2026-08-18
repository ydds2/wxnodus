// src/wxnodus-ui/lib/inputHighlight.ts — 输入区 token 高亮（② 波 1）
// gemini highlight.ts:29-57 移植要点：三类 token 正则（斜杠命令 / @提及 / 占位符）+ LRU
// 缓存。渲染层走 ANSI 内联着色（textInput 既有 invert/dim 同机制——不依赖主题 token）。
export type TokenKind = 'mention' | 'slash' | 'placeholder'

export interface TokenSpan {
  start: number
  end: number
  kind: TokenKind
}

const PATTERNS: Array<{ kind: TokenKind; re: RegExp }> = [
  // 斜杠命令（词首 /，后接 1-40 个字母数字连字符——/compact、/model 等）
  { kind: 'slash', re: /(?<=^|\s)\/[\w-]{1,40}/g },
  // @提及/路径（@ 后接路径字符——@src/kernel/agent.ts）
  { kind: 'mention', re: /@[\w./\\-]{1,80}/g },
  // 占位符（{{name}} 模板槽——表单类提示词常用）
  { kind: 'placeholder', re: /\{\{[\w.-]{1,40}\}\}/g },
]

/** 三类 token 扫描（按起始位置排序、重叠丢弃——先声明的模式优先；纯函数） */
export function scanInputTokens(text: string): TokenSpan[] {
  const found: TokenSpan[] = []
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index
      if (start === undefined) continue
      found.push({ start, end: start + m[0].length, kind })
    }
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end)
  const out: TokenSpan[] = []
  let lastEnd = -1
  for (const s of found) {
    if (s.start < lastEnd) continue // 重叠：先声明模式（斜杠 > 提及 > 占位符）优先
    out.push(s)
    lastEnd = s.end
  }
  return out
}

// LRU 缓存（gemini 同款：输入重渲染频繁，同文本命中即复用）
const CACHE_MAX = 64
const cache = new Map<string, TokenSpan[]>()
export function highlightTokens(text: string): TokenSpan[] {
  const hit = cache.get(text)
  if (hit) return hit
  const spans = scanInputTokens(text)
  cache.set(text, spans)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return spans
}

const ANSI_BY_KIND: Record<TokenKind, string> = {
  mention: '\x1b[35m', // 品红（@路径/提及）
  slash: '\x1b[36m', // 青（斜杠命令）
  placeholder: '\x1b[2m', // 暗（占位符）
}

/** 文本 → 内联 ANSI 着色文本（无 token 原样返回零开销） */
export function highlightInputAnsi(text: string): string {
  const spans = highlightTokens(text)
  if (!spans.length) return text
  let out = ''
  let pos = 0
  for (const s of spans) {
    out += text.slice(pos, s.start) + ANSI_BY_KIND[s.kind] + text.slice(s.start, s.end) + '\x1b[0m'
    pos = s.end
  }
  return out + text.slice(pos)
}
