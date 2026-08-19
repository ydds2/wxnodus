// src/wxnodus-ui/rpc/workspaceRpc.ts — P1 工作台 RPC 数据构建（2026-08-20）
// 定位：status/doctor 结构化工作台的真实数据源（与 C-02 diffRpc/sessionRpc 同模式——
// 结构子集端口 + 纯函数构建，不 import wxGateway，零新环）。
// 数据分层诚实口径：status = gateway 内核端口（模型/模式/目录/档案/余额/命令/会话/后台任务）
// ∪ TUI 状态（成本/上下文/权限——由 slash 命令合并，与状态栏同源）；doctor = adapter.data.doctor()
// 真实体检（db 完整性/记忆层/FTS/密钥解密/当前模型）。
import type { WorkspaceData, WorkspaceKind, WorkspaceRow } from '../bridge/interfaces.js'

export interface WorkspaceRpcKernel {
  settings: { apiKeyEnc?: string | null; model?: string; mode?: string; theme?: string; thinking?: boolean }
  cwd: string
  config: any
  adapter: {
    data: {
      sessions: { list(limit: number): Array<{ id: string }> }
      doctor(): WorkspaceRow[]
    }
  }
  taskRunner?: { list?(): unknown[] }
  term?: { list?(): unknown[] }
}

export interface WorkspaceStatusPorts {
  commandCount: number
  skillCount: number
}

const toneFor = (value: string | undefined): WorkspaceRow['tone'] => (value ? 'ok' : 'muted')

/** status 工作台行（内核端口侧——TUI 侧的成本/上下文/权限由 slash 命令合并） */
export function buildWorkspaceStatus(kernel: WorkspaceRpcKernel, ports: WorkspaceStatusPorts): WorkspaceData {
  const sections: WorkspaceData['sections'] = []
  const cfg = (() => {
    try {
      return ((kernel.config?.get?.('settings') ?? kernel.config ?? {}) as Record<string, any>) || {}
    } catch {
      return {}
    }
  })()

  const sessionRows: WorkspaceRow[] = []
  let sessionCount = 0
  try {
    sessionCount = kernel.adapter.data.sessions.list(50).length
  } catch { /* 会话列表失败按 0 */ }
  sessionRows.push({ k: '会话', v: `${sessionCount} 个（Ctrl+X 浏览/恢复）`, tone: sessionCount ? 'ok' : 'muted' })

  const modelRows: WorkspaceRow[] = []
  modelRows.push({ k: '模型', v: kernel.settings.model || '未配置（/model set-key <密钥>）', tone: toneFor(kernel.settings.model) })
  modelRows.push({ k: '模式', v: kernel.settings.mode || 'smart', tone: 'ok' })
  modelRows.push({ k: '目录', v: kernel.cwd, tone: 'ok' })
  modelRows.push({ k: '主题', v: kernel.settings.theme || '默认', tone: toneFor(kernel.settings.theme) })

  const envRows: WorkspaceRow[] = []
  const providers = Array.isArray(cfg.providers) ? cfg.providers : []
  const activeP = providers.find((p: Record<string, any>) => p?.id === cfg.activeProvider)
  envRows.push({
    k: '接入档案',
    v: activeP ? `${activeP.id}（${activeP.name ?? ''}）` : providers.length ? '未切换（/profile use）' : '未配置（/profile add 接入任意端点）',
    tone: activeP || providers.length ? 'ok' : 'muted'
  })
  const bm = (cfg.balanceMonitor ?? {}) as Record<string, any>
  envRows.push({
    k: '余额监控',
    v: bm.enabled === false ? '已关闭（/balance on）' : bm.url || activeP?.balanceUrl ? '已配置（状态栏 💰）' : '未配置（/balance set <余额URL>）',
    tone: bm.url || activeP?.balanceUrl ? 'ok' : 'muted'
  })
  envRows.push({ k: '命令', v: `${ports.commandCount} 个（/help 全目录）`, tone: 'ok' })
  envRows.push({ k: '技能', v: `${ports.skillCount} 个（/skills 管理）`, tone: ports.skillCount ? 'ok' : 'muted' })

  let bgCount = 0
  try {
    const termCount = (kernel.term?.list?.() ?? []).length
    const taskCount = (kernel.taskRunner?.list?.() ?? []).length
    bgCount = termCount + taskCount
  } catch { /* 后台计数失败按 0 */ }
  envRows.push({ k: '后台活动', v: bgCount ? `${bgCount} 个（/jobs 查看）` : '无', tone: bgCount ? 'ok' : 'muted' })

  sections.push({ label: '会话', rows: sessionRows })
  sections.push({ label: '模型与目录', rows: modelRows })
  sections.push({ label: '环境', rows: envRows })

  return { title: '状态工作台（w 切换体检 · Esc 关闭）', sections }
}

/** doctor 工作台（adapter.data.doctor() 真实体检行——与内核 /doctor 同源检查项） */
export function buildWorkspaceDoctor(kernel: WorkspaceRpcKernel): WorkspaceData {
  let rows: WorkspaceRow[] = []
  try {
    rows = kernel.adapter.data.doctor()
  } catch {
    rows = [{ k: '体检', v: '不可用（adapter.doctor 端口失败）', tone: 'bad' }]
  }
  return {
    title: '体检工作台（w 切换状态 · Esc 关闭）',
    sections: [{ label: '体检项（真实检测）', rows }]
  }
}

/** w 键切换目标（status → doctor → sessions → status 三标签循环） */
export function nextWorkspaceKind(ws: WorkspaceKind): WorkspaceKind {
  return ws === 'status' ? 'doctor' : ws === 'doctor' ? 'sessions' : 'status'
}

/** 会话工作台占位数据（渲染走 ActiveSessionSwitcher——data 仅承载标题） */
export function sessionsWorkspaceData(): WorkspaceData {
  return { title: '会话工作台（w 切换标签 · Esc 关闭）', sections: [] }
}
