// src/tui/viewport.ts — 视口钳制纯函数（输入框/参数钉底的核心机制）
// 机制参考：codex render.rs:33-34 行配额 + 终端视口裁剪（"只显示最新，历史可翻"），
// 实现原创：CJK 宽度感知的硬换行 + 条目粒度切片（不依赖 ink 内部 wrap，行数可预测）。
// 设计约束（用户裁决）：输入框与参数常驻 cmd 底部——转录流钳制到「终端行数 − 固定区行数」。

/** ANSI 转义剥离（模型输出偶含颜色码——测量前清掉，防行数虚高） */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

/** 组合标记宽度 0（声调/变音符不占列） */
const COMBINING_RE = /[\u0300-\u036F\u1AB0-\u1AFF\u20D0-\u20FF\uFE20-\uFE2F]/

/** 宽字符（CJK/全角/制表线/块元素/几何符/箭头——Windows 终端按 2 列渲染；
 *  模糊宽度按宽计 = 高估方向：行数预算只多不少，钉底永不漂移） */
const WIDE_RE = /[\u1100-\u115F\u2190-\u21FF\u2500-\u25FF\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{2FA1F}\uE000-\uF8FF]/u

/** 单字符终端列宽（wide=2 · combining=0 · 其余=1） */
export function charWidth(ch: string): number {
  if (COMBINING_RE.test(ch)) return 0
  if (WIDE_RE.test(ch)) return 2
  return 1
}

/** 字符串显示宽度（ANSI 已剥离） */
export function strWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch)
  return w
}

/** 硬换行：按显示宽度断行（与 renderMarkdownLite 的渲染宽度一致——行数可预测） */
/** ⅩⅩⅧ：单行分词——CJK 每字成词、ASCII 连续串聚合（URL/路径/命令参数为不可分词） */
export function splitLineWords(rawLine: string): string[] {
  const tokens: string[] = []
  let tok = ''
  let tokCjk = false
  for (const ch of rawLine) {
    const cjk = charWidth(ch) >= 2
    const blank = ch === ' ' || ch === '\t'
    if (blank) { if (tok) { tokens.push(tok); tok = '' } tokens.push(' '); tokCjk = false; continue }
    if (cjk) { if (tok && !tokCjk) { tokens.push(tok); tok = '' } tokens.push(ch); tokCjk = true; continue }
    if (tokCjk && tok) { tokens.push(tok); tok = '' }
    tokCjk = false
    tok += ch
  }
  if (tok) tokens.push(tok)
  return tokens
}

/** ⅩⅩⅧ：词布局——词边界换行（整词移下一行）；仅单词超行宽才硬切（可见性优先） */
export function layoutWords(tokens: string[], width: number): string[] {
  const w = Math.max(4, width)
  const out: string[] = []
  let cur = ''
  let curW = 0
  const pushLine = () => { out.push(cur.replace(/ +$/, '')); cur = ''; curW = 0 }
  for (const t of tokens) {
    if (t === ' ') { if (curW > 0) { cur += ' '; curW += 1 } continue }
    let tw = 0
    for (const ch of t) tw += charWidth(ch)
    if (curW + tw > w && cur.length > 0) pushLine()
    if (tw > w) {
      for (const ch of t) {
        const cw = charWidth(ch)
        if (curW + cw > w && cur.length > 0) pushLine()
        cur += ch
        curW += cw
      }
      continue
    }
    cur += t
    curW += tw
  }
  if (cur.length > 0) out.push(cur.replace(/ +$/, ''))
  return out
}

export function wrapText(text: string, width: number): string[] {
  const w = Math.max(4, width)
  const clean = text.replace(ANSI_RE, '')
  const out: string[] = []
  for (const rawLine of clean.split('\n')) {
    if (rawLine.length === 0) { out.push(''); continue }
    out.push(...layoutWords(splitLineWords(rawLine), w))
  }
  return out
}

/** 文本段行数 */
export function rowsOfText(text: string, width: number): number {
  return Math.max(1, wrapText(text, width).length)
}

/** 可视窗口：从尾部回填 entries，返回 { items, hiddenAbove, hiddenBelow } */
export interface ViewportSlice<T> {
  /** 需要渲染的条目（时间序） */
  items: Array<{ entry: T; fromLine: number; toLine: number }>
  /** 上方被裁掉的行数（↑ 标记） */
  hiddenAbove: number
  /** 下方被裁掉的行数（↓ 标记；offset>0 且已回底为 0） */
  hiddenBelow: number
}

/**
 * 条目粒度钳制：
 * - rowsOf(entry) 给定每条目行数；
 * - offset 为「从底部回退的行数」（0 = 跟随尾部）；超界自动钳制到视口贴顶（total − budget）；
 * - maxRows 为转录区可用行数（标记行另算，由调用方扣除）。
 * 单条目超过可用行时截取尾部行（fromLine>0 表达）。
 */
export function sliceViewport<T>(
  entries: T[],
  rowsOf: (entry: T) => number,
  maxRows: number,
  offset: number,
): ViewportSlice<T> {
  const budget = Math.max(1, maxRows)
  // 超界钳制：offset 至多把视口推到最旧内容（贴顶）——不会翻出空窗
  const total = entries.reduce((a, e) => a + rowsOf(e), 0)
  let skip = Math.min(Math.max(0, offset), Math.max(0, total - budget))
  const items: ViewportSlice<T>['items'] = []
  let acc = 0
  let hiddenAbove = 0
  let below = 0
  // 从尾部向前
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const rows = rowsOf(entry)
    if (skip > 0) {
      // offset 跳过的条目 = 视口下方（更新的内容）
      below += rows
      skip -= rows
      continue
    }
    const space = budget - acc
    if (space <= 0) {
      hiddenAbove += rows
      continue
    }
    if (rows <= space) {
      items.unshift({ entry, fromLine: 0, toLine: rows })
      acc += rows
    } else {
      // 超大条目：只渲染其尾部 space 行
      const fromLine = rows - space
      items.unshift({ entry, fromLine, toLine: rows })
      hiddenAbove += fromLine
      acc += space
    }
  }
  // 下方隐藏行数（offset 未消费完的部分——用户翻上去了）
  const hiddenBelow = Math.max(0, below + skip)
  return { items, hiddenAbove: Math.max(0, hiddenAbove), hiddenBelow }
}

/**
 * 顶锚定切片（上翻阅读时视口冻结——流式新内容不推走当前视口；kimi/codex 同行为）：
 * 从第 topLine 行起正向填充 budget 行；新内容只计入 hiddenBelow（↓ 标记实时计数）。
 */
export function sliceViewportFromTop<T>(
  entries: T[],
  rowsOf: (entry: T) => number,
  maxRows: number,
  topLine: number,
): ViewportSlice<T> {
  const budget = Math.max(1, maxRows)
  const items: ViewportSlice<T>['items'] = []
  let skipped = Math.max(0, topLine)
  let acc = 0
  let total = 0
  for (const entry of entries) {
    const rows = rowsOf(entry)
    total += rows // 全量累计（↓ 计数必须完整——视口满后仍继续累加）
    if (acc >= budget) continue
    if (skipped >= rows) { skipped -= rows; continue }
    const from = skipped > 0 ? skipped : 0
    skipped = 0
    const take = Math.min(rows - from, budget - acc)
    if (take > 0) { items.push({ entry, fromLine: from, toLine: from + take }); acc += take }
  }
  const hiddenBelow = Math.max(0, total - Math.max(0, topLine) - acc)
  return { items, hiddenAbove: Math.max(0, topLine), hiddenBelow }
}

/** 底部固定区行数预算：转录区 = rows − fixed；最小 3 行（极端小窗保输入框可见） */
export function transcriptBudget(rows: number, fixedRows: number): number {
  return Math.max(3, Math.floor(rows) - Math.floor(fixedRows))
}
