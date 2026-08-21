// src/wxnodus-ui/components/statusBarSegments.ts — V4 L0-4：状态栏内容段纯函数模块
//
// 六段内容模型（model|cost|session|budget|net|state）——数据全部来自结构化状态，
// 文本与语义色在此决定（单一事实源）；StatusRule 消费段输出，布局协商（宽度档）
// 仍归 lib/layoutProfile.ts（内容层与宽度层正交）。
// 密度显隐（docs/output-spec-v1.md §3）：cozy 全段 / compact 隐 budget+net / dense 仅 model+state+cost。
// budget/net 段数据位预留：budget 来自 /perm budget 同源查询（V4 P0-3 联动）、
// net 来自重连状态机（V4 P2-1 落地时填充）——缺省 undefined 则该段省略。
import type { Density, SemanticColor } from '../output/spec.js'

export type StatusSegmentId = 'model' | 'cost' | 'session' | 'budget' | 'net' | 'state'

export interface StatusSegment {
  id: StatusSegmentId
  text: string
  color: SemanticColor
  /** 宽度紧张时让位顺序（大者先让） */
  priority: number
}

export interface StatusBarUsage {
  total?: number
  context_used?: number
  context_max?: number
  context_percent?: number
  cost_usd?: number
}

export interface StatusBarState {
  model?: string
  modelEffort?: string
  modelFast?: boolean
  usage?: StatusBarUsage
  /** 余额展示（低余额红色——结构化 low 标记，非文本猜测） */
  balance?: { label: string; low?: boolean; stale?: boolean }
  session?: { liveCount?: number; title?: string }
  /** 工具执行预算余量（/perm budget 同源；V4 P0-3 联动） */
  budget?: { used: Record<string, number>; limits: Record<string, number> }
  /** 网络重连态（V4 P2-1 重连工程落地时填充） */
  net?: { reconnecting?: boolean; attempt?: number; nextRetryMs?: number }
  state: 'busy' | 'ready' | 'error'
  statusText: string
  density?: Density
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortModel(model: string): string {
  return model.replace(/^.*\//, '').slice(0, 24)
}

/** 六段构建（纯函数）：缺数据的段自然省略；密度档控制显隐 */
export function buildStatusSegments(s: StatusBarState): StatusSegment[] {
  const density = s.density ?? 'cozy'
  const segs: StatusSegment[] = []

  // model 段（全密度）
  if (s.model) {
    let text = shortModel(s.model)
    if (s.modelFast) text += '·fast'
    if (s.modelEffort && density === 'cozy') text += `·${s.modelEffort}`
    segs.push({ id: 'model', text, color: 'accent', priority: 90 })
  }

  // cost 段（全密度）：回合/会话成本 + 上下文用量
  if (s.usage) {
    const parts: string[] = []
    if (typeof s.usage.cost_usd === 'number' && s.usage.cost_usd > 0) {
      parts.push(`$${s.usage.cost_usd < 1 ? s.usage.cost_usd.toFixed(4) : s.usage.cost_usd.toFixed(2)}`)
    }
    if (s.usage.context_max) {
      parts.push(`${fmtK(s.usage.context_used ?? 0)}/${fmtK(s.usage.context_max)}`)
    } else if ((s.usage.total ?? 0) > 0) {
      parts.push(`${fmtK(s.usage.total ?? 0)} tok`)
    }
    if (parts.length) {
      const pct = s.usage.context_percent
      segs.push({
        id: 'cost',
        text: parts.join(' '),
        // 上下文水位着色（结构化 percent）：≥85 error（压缩线）、≥75 warn（预警线）
        color: pct !== undefined && pct >= 85 ? 'error' : pct !== undefined && pct >= 75 ? 'warn' : 'muted',
        priority: 60,
      })
    }
  }

  // balance 段（并 cost）：低余额红（结构化 low——痛点「额度不透明」对策锚点）
  if (s.balance?.label) {
    segs.push({
      id: 'cost',
      text: s.balance.label,
      color: s.balance.low ? 'error' : s.balance.stale ? 'warn' : 'muted',
      priority: 50,
    })
  }

  // session 段（cozy/compact）
  if (density !== 'dense' && s.session) {
    const text = s.session.liveCount && s.session.liveCount > 1
      ? `${s.session.liveCount} 会话`
      : s.session.title
        ? `${s.session.title.slice(0, 16)}`
        : ''
    if (text) segs.push({ id: 'session', text, color: 'muted', priority: 40 })
  }

  // budget 段（仅 cozy）：余量最紧的工具类（«used/limit»；余量 <20% warn）
  if (density === 'cozy' && s.budget) {
    let worst: { key: string; used: number; limit: number } | null = null
    for (const [key, limit] of Object.entries(s.budget.limits)) {
      const used = s.budget.used[key] ?? 0
      if (!worst || used / Math.max(1, limit) > worst.used / Math.max(1, worst.limit)) {
        worst = { key, used, limit }
      }
    }
    if (worst && worst.used > 0) {
      const left = Math.max(0, worst.limit - worst.used)
      segs.push({
        id: 'budget',
        text: `§${worst.key.slice(0, 6)} ${worst.used}/${worst.limit}`,
        color: left / Math.max(1, worst.limit) < 0.2 ? 'warn' : 'muted',
        priority: 30,
      })
    }
  }

  // net 段（cozy/compact）：重连可见性（P2-1「等待网络」模式的展示位）
  if (density !== 'dense' && s.net?.reconnecting) {
    const retry = s.net.attempt ? ` 第${s.net.attempt}次` : ''
    const next = s.net.nextRetryMs ? ` ${Math.round(s.net.nextRetryMs / 1000)}s后` : ''
    segs.push({ id: 'net', text: `↻ 重连中${retry}${next}`, color: 'warn', priority: 70 })
  }

  // state 段（全密度）
  segs.push({
    id: 'state',
    text: s.statusText,
    color: s.state === 'error' ? 'error' : s.state === 'busy' ? 'accent' : 'muted',
    priority: 100,
  })

  return segs
}

/** 按段 id 取首个段（消费便利） */
export function segmentById(segs: StatusSegment[], id: StatusSegmentId): StatusSegment | undefined {
  return segs.find(s => s.id === id)
}
