// src/tui/markdown.ts — Markdown-lite 行渲染器（原型场景 25「输出全谱」+ 01 diff 染色的实现侧）
// 机制参考：kimi _blocks.py:275「已确认块落屏」+ codex render.rs:33-34 行配额——输出按块提交、配额收口；
// 实现原创：一次性行级解析 + 段式染色（**粗体/`代码`/#标题/>引用/围栏/有序无序列表），diff 两遍判定防误伤。
// 刻意不做：表格重排、任务列表勾选、链接渲染——cmd 终端下这些是噪音（用户裁决：简易干净优先）。
import { wrapText, splitLineWords, layoutWords } from './viewport.js'

export interface Seg {
  text: string
  bold?: boolean
  code?: boolean
  /** ink 命名色（缺省 = 正文色） */
  color?: string
}

export type LineKind = 'normal' | 'fence' | 'fence-end' | 'quote' | 'header' | 'diff-add' | 'diff-del' | 'diff-hunk' | 'diff-meta' | 'blank'

export interface Line {
  kind: LineKind
  segs: Seg[]
}

/** 该行是否「潜在 diff 行」（± 开头但非 +++/--- 元信息） */
const isDiffCandidate = (line: string): boolean =>
  /^\+[^+]/.test(line) || /^-[^-]/.test(line)

/** 全文是否像 diff（有 hunk 头 / 元信息 / 连续候选 ≥2）——两遍判定，防误伤列表项 */
function looksLikeDiff(lines: string[]): boolean {
  let run = 0
  let hasMeta = false
  for (const l of lines) {
    if (/^@@/.test(l) || /^(---|\+\+\+)\s/.test(l) || /^diff --git/.test(l) || /^index [0-9a-f]{7}/.test(l)) hasMeta = true
    if (isDiffCandidate(l)) { run += 1 } else { run = 0 }
    if (run >= 2 || hasMeta) return true
  }
  return false
}

/** 行内解析：**粗体** / `代码`（失配标记丢弃——块提交模式，绝不为半个标记崩渲染） */
function parseInline(text: string, extra: { bold?: boolean; color?: string } = {}): Seg[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  const segs: Seg[] = []
  for (const p of parts) {
    if (p.length === 0) continue
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
      segs.push({ text: p.slice(2, -2), bold: true, ...extra })
    } else if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      segs.push({ text: p.slice(1, -1), code: true, color: extra.color ?? 'cyanBright' })
    } else {
      segs.push({ text: p, ...extra })
    }
  }
  return segs.length ? segs : [{ text, ...extra }]
}

/**
 * Markdown-lite → 渲染行（已硬换行到 width；调用方逐行打印，行数 = 视图行数）。
 */
export function renderMarkdownLite(text: string, width: number): Line[] {
  const w = Math.max(8, width)
  const raw = text.replace(/\r/g, '').split('\n')
  const asDiff = looksLikeDiff(raw)
  const out: Line[] = []
  let inFence = false

  for (const rawLine of raw) {
    const trimmed = rawLine.trim()
    const indent = rawLine.length - rawLine.trimStart().length

    // 围栏开关
    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true
        const lang = trimmed.slice(3).trim()
        out.push({ kind: 'fence', segs: [{ text: '```' + (lang ? ` ${lang}` : ''), color: 'gray' }] })
      } else {
        inFence = false
        out.push({ kind: 'fence-end', segs: [{ text: '```', color: 'gray' }] })
      }
      continue
    }
    if (inFence) {
      // 围栏内容：不解析行内、不染色——原样保留（代码即权威）
      for (const l of wrapPlain(rawLine, w - 2)) out.push({ kind: 'fence', segs: [{ text: l, color: 'gray' }] })
      continue
    }

    // diff 行（两遍判定通过才染色——原型 01/54 红绿对照）
    if (asDiff && /^@@/.test(trimmed)) {
      for (const l of wrapPlain(rawLine, w)) out.push({ kind: 'diff-hunk', segs: [{ text: l, color: 'cyanBright' }] })
      continue
    }
    if (asDiff && /^(---|\+\+\+)\s/.test(trimmed)) {
      for (const l of wrapPlain(rawLine, w)) out.push({ kind: 'diff-meta', segs: [{ text: l, color: 'gray' }] })
      continue
    }
    if (asDiff && /^\+[^+]/.test(rawLine)) {
      for (const l of wrapPlain(rawLine, w)) out.push({ kind: 'diff-add', segs: [{ text: l, color: 'greenBright' }] })
      continue
    }
    if (asDiff && /^-[^-]/.test(rawLine)) {
      for (const l of wrapPlain(rawLine, w)) out.push({ kind: 'diff-del', segs: [{ text: l, color: 'red' }] })
      continue
    }

    if (trimmed.length === 0) { out.push({ kind: 'blank', segs: [{ text: '' }] }); continue }

    // 标题（h1-h4）：accent 粗体，去 # 前缀
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (h) {
      for (const l of wrapInline(h[2]!, w - indent)) out.push({ kind: 'header', segs: parseInline(l, { bold: true, color: 'cyanBright' }) })
      continue
    }

    // 引用：muted + 「│ 」前缀（原型 note/引用样式）
    if (/^>/.test(trimmed)) {
      const body = trimmed.replace(/^>\s?/, '')
      const lines = wrapInline(body, w - indent - 2)
      out.push({ kind: 'quote', segs: [{ text: '│ ', color: 'gray' }, ...parseInline(lines[0] ?? '')] })
      for (const l of lines.slice(1)) out.push({ kind: 'quote', segs: [{ text: '│ ', color: 'gray' }, ...parseInline(l)] })
      continue
    }

    // 列表（- / * / • / 有序）：保留项目符
    const bullet = /^(\s*)([-*•]|\d+[.)])\s+/.exec(rawLine)
    if (bullet) {
      const marker = bullet[2]!.length > 1 ? `${bullet[2]!} ` : `${bullet[2]! === '•' ? '•' : '·'} `
      const body = rawLine.slice(bullet[0]!.length)
      const lines = wrapInline(body, w - indent - 2)
      out.push({ kind: 'normal', segs: [{ text: marker, color: 'gray' }, ...parseInline(lines[0] ?? '')] })
      for (const l of lines.slice(1)) out.push({ kind: 'normal', segs: [{ text: '  ' }, ...parseInline(l)] })
      continue
    }

    for (const l of wrapInline(rawLine, w)) out.push({ kind: 'normal', segs: parseInline(l) })
  }
  if (inFence) out.push({ kind: 'fence-end', segs: [{ text: '```', color: 'gray' }] }) // 未闭合围栏诚实收口
  return out
}

/** 行内解析 + 硬换行（分段后重解析——块提交模式：跨行失配标记安全丢弃） */
function wrapInline(text: string, width: number): string[] {
  const w = Math.max(4, width)
  // ⅩⅩⅧ：词感知换行——行内标记块（**粗体**/`代码`）与长串（URL/路径）同为不可分词；
  // 词边界换行（整词移下一行），仅超行宽才硬切。与 viewport wrapText 同核（布局复用）。
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(p => p.length > 0)
  const words: string[] = []
  for (const p of parts) {
    if (/^(\*\*[^*]+\*\*|`[^`]+`)$/.test(p)) words.push(p)
    else words.push(...splitLineWords(p))
  }
  return layoutWords(words, w)
}

/** 纯文本硬换行（围栏/diff 行——不解析行内；ⅩⅩⅧ 起词感知，委托 viewport wrapText 同核） */
function wrapPlain(text: string, width: number): string[] {
  return wrapText(text, width)
}

/** 取字符串前缀使显示宽度 ≤ max（全取不下时按字符硬切） */
// takeWidth 已随 ⅩⅩⅧ 词感知换行退役（wrapInline 改 layoutWords 布局）

