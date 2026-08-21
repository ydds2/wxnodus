// src/wxnodus-ui/output/spec.ts — 输出规范 v1（V4 L0-1）：单一事实源
//
// 设计原则（docs/output-spec-v1.md，版本化变更）：
// 1. 输出形态由类型化事件决定；渲染层 = 纯函数 (OutputEvent, Density) → RenderBlock[]
// 2. 状态由结构化 outcome 决定，禁止内容正则猜测（渲染侧零正则——lint 禁则见 spec 文档）
// 3. 一套模型三后端：TUI(ink) / ANSI 纯文本(-p) / JSON(stream-json) 消费同一 RenderBlock
// 4. 颜色用语义名（SemanticColor），主题映射由渲染器完成（spec 主题无关）
// 5. 密度三档 cozy/compact/dense，所有形态在三档下有定义
//
// 变更纪律：本文件即规范——任何格式变更必须递增 OUTPUT_SPEC_VERSION 并更新
// docs/output-spec-v1.md 变更记录；禁止「全量替换式」打补丁（V3 输出体系教训）。

/** 规范版本（格式变更即递增；快照矩阵与 spec 文档同步演进） */
export const OUTPUT_SPEC_VERSION = 1

// ── 密度档 ────────────────────────────────────────────────────────────
export type Density = 'cozy' | 'compact' | 'dense'

// ── 语义色（单一事实源；渲染器映射到 ThemeColors）──────────────────────
/** accent=动作/可交互 · error=失败（仅结构化判定）· warn=需注意/被拒 ·
 *  muted=元信息/结果 · ok=终态确认 · text=正文 */
export type SemanticColor = 'accent' | 'error' | 'warn' | 'muted' | 'ok' | 'text'

// ── OutputEvent 分类学（十类）──────────────────────────────────────────
export type ToolOutcome = 'ok' | 'failed' | 'denied' | 'cached' | 'timeout'

export type OutputEvent =
  | { kind: 'user'; text: string; attachments?: string[] }
  | { kind: 'assistant'; text: string; streaming?: boolean }
  | { kind: 'reasoning'; text: string; tokens: number; streaming?: boolean }
  | { kind: 'tool-start'; name: string; argsSummary: string }
  | { kind: 'tool-result'; name: string; outcome: ToolOutcome; preview: string; tokens?: number; durationMs?: number }
  | { kind: 'diff'; file: string; body: string }
  | { kind: 'command'; name: string; output: string; exitCode?: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; scope: 'core' | 'rpc' | 'transient'; text: string }
  | { kind: 'turn-summary'; turns: number; tokens: number; costUsd: number; durationMs: number }
  | { kind: 'session-event'; type: string; text: string }

// ── 折叠协议 ──────────────────────────────────────────────────────────
/** 折叠统一交互（reasoning / 工具结果全文 / 长输出 / diff）：
 * `▸/▾ 标题 (计数)` + 展开限高 + 点击/Ctrl+O 切换。规则见 collapsePolicy。 */
export interface FoldPolicy {
  collapsed: boolean
  title: string
  badge: string
}

export function fmtKTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

/** 折叠规则（density 相关）：折叠判定基于行数与类型，非内容猜测 */
export function collapsePolicy(ev: OutputEvent, density: Density): FoldPolicy | null {
  switch (ev.kind) {
    case 'reasoning':
      return { collapsed: true, title: '推理', badge: `${fmtKTokens(ev.tokens)} tokens` }
    case 'tool-result': {
      const lines = ev.preview.split('\n').length
      const threshold = density === 'cozy' ? 3 : density === 'compact' ? 1 : 1
      if (lines <= threshold) return null
      return { collapsed: true, title: `${ev.name} 结果`, badge: `${lines} 行` }
    }
    case 'command': {
      const lines = ev.output.split('\n').length
      const threshold = density === 'cozy' ? 5 : density === 'compact' ? 2 : 1
      if (lines <= threshold) return null
      return { collapsed: true, title: ev.name, badge: `${lines} 行` }
    }
    default:
      return null
  }
}

// ── 渲染块（后端无关中间表示）──────────────────────────────────────────
export interface RenderBlock {
  kind:
    | 'user'        // ❯ 行
    | 'assistant'   // markdown 正文（渲染器解析）
    | 'tool'        // ⏺ 动作行
    | 'result'      // ⎿ 结果行
    | 'fold'        // ▸ 折叠标题行
    | 'diff'        // diff 正文（渲染器走 DiffRenderer）
    | 'notice'      // 通知行
    | 'summary'     // ◦ 回合尾行
    | 'event'       // ◈ 时间线行
    | 'command'     // 命令输出块
  glyph?: string
  text: string
  color: SemanticColor
  dim?: boolean
  indent: number
  streaming?: boolean
  fold?: FoldPolicy
  /** diff/command 折叠态下首行预览 */
  preview?: string
}

// ── 语义色映射（结构化 → 颜色，零正则）────────────────────────────────
export function toolOutcomeColor(outcome: ToolOutcome): SemanticColor {
  switch (outcome) {
    case 'failed': return 'error'
    case 'denied': return 'warn'
    case 'timeout': return 'warn'
    case 'cached': return 'muted'
    case 'ok': return 'muted'
  }
}

export function toolOutcomeMark(outcome: ToolOutcome): string {
  switch (outcome) {
    case 'failed': return ''      // 红色即失败（结构化判定——不再用 ✗ 字符猜测）
    case 'denied': return '⊘ '
    case 'timeout': return '⏱ '
    case 'cached': return '⟳ '
    case 'ok': return ''
  }
}

/** session-event 类型 → 语义色（结构化 type 映射，替代 V3 的三段内容正则） */
export function sessionEventColor(type: string): SemanticColor {
  switch (type) {
    case 'session.switched':
    case 'session.restored':
    case 'session.started':
      return 'accent'
    case 'job.completed':
    case 'save.completed':
    case 'restore.completed':
      return 'ok'
    case 'job.failed':
    case 'session.error':
      return 'error'
    default:
      return 'muted'
  }
}

export function noticeColor(level: 'info' | 'warn' | 'error'): SemanticColor {
  switch (level) {
    case 'error': return 'error'
    case 'warn': return 'warn'
    case 'info': return 'muted'
  }
}

// ── 形态映射主函数（纯函数：事件 × 密度 → 渲染块序列）──────────────────
export function renderEvent(ev: OutputEvent, density: Density): RenderBlock[] {
  switch (ev.kind) {
    case 'user': {
      const blocks: RenderBlock[] = [
        { kind: 'user', glyph: '❯ ', text: ev.text, color: 'muted', indent: 0 },
      ]
      if (ev.attachments?.length) {
        blocks.push({ kind: 'user', glyph: '📎 ', text: ev.attachments.join(' · '), color: 'muted', dim: true, indent: 1 })
      }
      return blocks
    }
    case 'assistant':
      return [{ kind: 'assistant', text: ev.text, color: 'text', indent: 1, streaming: ev.streaming }]
    case 'reasoning': {
      const fold = collapsePolicy(ev, density)!
      if (density === 'dense') {
        // dense：推理完全不可见（仅保留 badge 行，对标 Claude Code 默认）
        return [{ kind: 'fold', glyph: '▸ ', text: `${fold.title} (${fold.badge})`, color: 'muted', dim: true, indent: 1, fold }]
      }
      return [{ kind: 'fold', glyph: '▸ ', text: `${fold.title} (${fold.badge})`, color: 'muted', indent: 1, fold }]
    }
    case 'tool-start':
      return [{ kind: 'tool', glyph: '⏺ ', text: `${ev.name} ${ev.argsSummary}`.trimEnd(), color: 'accent', indent: 0, streaming: true }]
    case 'tool-result': {
      const fold = collapsePolicy(ev, density)
      const firstLine = ev.preview.split('\n')[0] ?? ''
      const mark = toolOutcomeMark(ev.outcome)
      const block: RenderBlock = {
        kind: 'result',
        glyph: '⎿ ',
        text: `${mark}${firstLine}`,
        color: toolOutcomeColor(ev.outcome),
        dim: ev.outcome === 'ok' || ev.outcome === 'cached',
        indent: 1,
      }
      if (fold) block.fold = fold
      if (density !== 'cozy' && ev.durationMs !== undefined) {
        // compact/dense：动作行带时长徽标（cozy 保持极简——对标 Claude Code 无时长）
        block.text += ` (${fmtDuration(ev.durationMs)})`
      }
      return [block]
    }
    case 'diff':
      return [{ kind: 'diff', text: ev.body, color: 'text', indent: 1, preview: ev.file }]
    case 'command': {
      const fold = collapsePolicy(ev, density)
      const block: RenderBlock = {
        kind: 'command',
        text: ev.output,
        color: 'muted',
        dim: true,
        indent: 1,
      }
      if (fold) block.fold = fold
      if (ev.exitCode !== undefined && ev.exitCode !== 0) {
        block.color = 'error'
        block.dim = false
      }
      return [block]
    }
    case 'notice': {
      // 作用域化（V4 A-26 同源）：rpc/transient 不进对话流——渲染器据此分流到活动区
      if (ev.scope !== 'core') return []
      return [{ kind: 'notice', glyph: ev.level === 'error' ? '✖ ' : ev.level === 'warn' ? '⚠ ' : '· ', text: ev.text, color: noticeColor(ev.level), indent: 1 }]
    }
    case 'turn-summary': {
      const parts = [
        `${ev.turns} 调用`,   // turns 语义=回合内工具调用次数（flowController 按 tool start 计）
        `${fmtKTokens(ev.tokens)} tokens`,
        ev.costUsd > 0 ? `$${ev.costUsd < 1 ? ev.costUsd.toFixed(4) : ev.costUsd.toFixed(2)}` : null,
        fmtDuration(ev.durationMs),
      ].filter((p): p is string => p !== null)
      return [{ kind: 'summary', glyph: '◦ ', text: parts.join(' · '), color: 'muted', dim: true, indent: 1 }]
    }
    case 'session-event':
      return [{ kind: 'event', glyph: '◈ ', text: ev.text, color: sessionEventColor(ev.type), indent: 0 }]
  }
}

/** 全事件 × 全密度快照矩阵的规格层基线（L0-6 渲染器矩阵以此为准） */
export const SPEC_MATRIX_KINDS: readonly OutputEvent['kind'][] = [
  'user', 'assistant', 'reasoning', 'tool-start', 'tool-result',
  'diff', 'command', 'notice', 'turn-summary', 'session-event',
]
export const SPEC_DENSITIES: readonly Density[] = ['cozy', 'compact', 'dense']
