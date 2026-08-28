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
  /** 会话累计明细（v4-status-bar-line2 兜底段载荷——gateway usage 原样透传） */
  calls?: number
  input?: number
  output?: number
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
  net?: { reconnecting?: boolean; attempt?: number; nextRetryMs?: number; /** V4 P2-10：429 限额态（resetAt 绝对时刻） */ rateLimitResetAt?: number }
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

  // net 段（cozy/compact）：重连可见性（P2-1）+ 429 限额（P2-10——额度 HH:mm 重置，warn）
  if (density !== 'dense' && s.net?.rateLimitResetAt && s.net.rateLimitResetAt > Date.now()) {
    segs.push({
      id: 'net',
      text: `⏳ 额度 ${new Date(s.net.rateLimitResetAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 重置`,
      color: 'warn',
      priority: 70,
    });
  } else if (density !== 'dense' && s.net?.reconnecting) {
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

// ── V4 UI 闭环（kimi-cli 双行状态栏规格参考·实现原创）────────────────────────
// 规格来源（机制参考，非代码抄写）：kimi-cli ui/shell/prompt.py _render_bottom_toolbar：
//   行1：状态旗标(yolo/afk/plan) + agent(model ●thinking) + cwd+git 徽章 + ⚙后台任务
//        + 30s 轮换 tips 填行尾；窄终端 full→mid→bare 逐级降级
//   行2：左 toast（通知）+ 右 context: %（used/max）
// wxnodus 内容置换：旗标=yolo/afk（wxnodus 既有模式）、模型点=busy thinking、
// cwd+git/⚙jobs=tuiPresentationAdapter 既有数据位、tips=wxnodus 快捷键轮换。

export interface StatusBarFlags { yolo?: boolean; afk?: boolean }
export interface StatusBarGit { branch: string; dirty?: boolean }
export interface StatusBarBgJobs { bash?: number; agents?: number }

/** kimi 式扩展状态位（缺省全部省略——向后兼容六段旧调用方） */
export interface StatusBarStateV2 extends StatusBarState {
  flags?: StatusBarFlags
  thinking?: boolean
  cwd?: string
  git?: StatusBarGit
  bgJobs?: StatusBarBgJobs
}

export interface StatusRow { segments: StatusSegment[] }
export interface StatusRows { line1: StatusRow; line2: StatusRow }

const WX_TIPS = [
  'ctrl-j: 换行', 'tab: 补全', 'esc×2: 中断', '/help: 全部命令',
  '@: 引用文件', '/theme: 换主题', 'ctrl-r: 历史', '双击: 复制消息',
]

/** 30s 轮换取两条 tips（kimi 同语义；now 可注入测试） */
export function rotatingTips(now: number): string {
  const i = Math.floor(now / 30_000) % WX_TIPS.length
  return `${WX_TIPS[i]} | ${WX_TIPS[(i + 1) % WX_TIPS.length]!}`
}

/** cwd 左截断（保尾部路径——kimi _truncate_left 同语义） */
export function truncateCwdLeft(cwd: string, maxCols: number): string {
  if (cwd.length <= maxCols) return cwd
  return '…' + cwd.slice(-(maxCols - 1))
}

/**
 * kimi 式双行构建（纯函数）：
 * line1 = state旗标·model(●/○thinking)·cwd+git·⚙jobs·tips
 * line2 = notice(toast 左) + context%(used/max 右) + $cost·§budget
 * 宽度紧张降级：tips 先丢 → git 徽章丢 → cwd 截断 → flags 保留（安全语义优先）
 */
export function buildStatusRows(s: StatusBarStateV2, cols = 80): StatusRows {
  const line1: StatusSegment[] = []
  // 状态旗标（kimi：yolo 黄粗/afk 橙粗——语义色映射 warn/error 系）
  if (s.flags?.yolo) line1.push({ id: 'state', text: 'yolo', color: 'warn', priority: 95 })
  if (s.flags?.afk) line1.push({ id: 'state', text: 'afk', color: 'error', priority: 95 })
  // model 段 + thinking 点（kimi agent (model ●)——busy 实心）
  if (s.model) {
    let text = shortModel(s.model)
    if (s.modelFast) text += '·fast'
    text += s.thinking ? ' ●' : ' ○'
    line1.push({ id: 'model', text, color: 'accent', priority: 90 })
  }
  // cwd + git 徽章（kimi：cwd 左截断 + branch±dirty）
  if (s.cwd) {
    let cwdText = truncateCwdLeft(s.cwd, Math.min(s.cwd.length, 28))
    if (s.git?.branch) cwdText += ` ${s.git.branch.slice(0, 16)}${s.git.dirty ? '*' : ''}`
    line1.push({ id: 'session', text: cwdText, color: 'muted', priority: 40 })
  }
  // ⚙ 后台任务徽章（kimi：⚙ bash: N / agent: N）
  if (s.bgJobs) {
    if ((s.bgJobs.bash ?? 0) > 0) line1.push({ id: 'net', text: `⚙ bash: ${s.bgJobs.bash}`, color: 'muted', priority: 30 })
    if ((s.bgJobs.agents ?? 0) > 0) line1.push({ id: 'net', text: `⚙ agent: ${s.bgJobs.agents}`, color: 'muted', priority: 29 })
  }
  // tips 填行尾（宽度允许时）
  const used = line1.reduce((n, seg) => n + seg.text.length + 2, 0)
  const tip = rotatingTips(Date.now())
  if (used + tip.length <= cols - 2) {
    line1.push({ id: 'budget', text: tip, color: 'muted', priority: 1 })
  }

  // line2：notice（toast 左）+ context%（右）+ cost/budget
  const line2: StatusSegment[] = []
  if (s.net?.reconnecting) line2.push({ id: 'net', text: '↻ 重连中', color: 'warn', priority: 70 })
  else if (s.net?.rateLimitResetAt && s.net.rateLimitResetAt > Date.now()) {
    line2.push({ id: 'net', text: `⏳ 额度 ${new Date(s.net.rateLimitResetAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 重置`, color: 'warn', priority: 70 })
  }
  if (s.usage) {
    const parts: string[] = []
    if (typeof s.usage.context_percent === 'number') {
      parts.push(`context: ${s.usage.context_percent}%`)
    }
    if (s.usage.context_max) parts.push(`(${fmtK(s.usage.context_used ?? 0)}/${fmtK(s.usage.context_max)})`)
    if (typeof s.usage.cost_usd === 'number' && s.usage.cost_usd > 0) parts.push(`$${s.usage.cost_usd < 1 ? s.usage.cost_usd.toFixed(4) : s.usage.cost_usd.toFixed(2)}`)
    if (!parts.length && (s.usage.total ?? 0) > 0) {
      // 兜底段：context 数据未到（目录外模型/端点未上报）时退化为会话累计 token——
      // 行2 恒有内容（静默消失让用户以为 UI 未更新——2026-08-22 真机反馈根因）
      parts.push(`session: ${fmtK(s.usage.total ?? 0)} tok`)
    }
    if (parts.length) {
      const pct = s.usage.context_percent
      line2.push({
        id: 'cost',
        text: parts.join(' '),
        color: pct !== undefined && pct >= 85 ? 'error' : pct !== undefined && pct >= 75 ? 'warn' : 'muted',
        priority: 60,
      })
    }
  }
  if (s.balance?.label) {
    line2.push({ id: 'cost', text: s.balance.label, color: s.balance.low ? 'error' : 'muted', priority: 50 })
  }
  return { line1: { segments: line1 }, line2: { segments: line2 } }
}
