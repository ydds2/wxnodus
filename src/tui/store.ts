// src/tui/store.ts — 自研轻量响应 store（零依赖：getSnapshot/subscribe/patch）
// 组件按订阅强制重渲（TUI 规模下整树渲染足够快——官方 ink 渲染管线自带帧合并）。
export interface ToolEntry {
  id: string
  name: string
  /** 一行摘要（降噪规则 1：工具名+1 个关键参数） */
  summary: string
  phase: 'run' | 'done' | 'fail'
  ms?: number
  /** 折叠详情（head5+tail5——降噪规则 3/4；Enter 展开） */
  detail?: string
  expanded?: boolean
}

/** 子代理行（原型 23：左状态点 + 目标摘要 + 终态一行——无卡片框） */
export interface AgentLine {
  id: string
  goal: string
  phase: 'run' | 'done' | 'fail'
  turns?: number
}

export interface ChatEntry {
  kind: 'user' | 'assistant' | 'notice' | 'error' | 'thinking' | 'tool' | 'fold' | 'agents'
  text?: string
  tool?: ToolEntry
  /** 折叠条（+N lines——精确计数） */
  fold?: { label: string; lines: string[] }
  /** 子代理编排块（本回合 agent.subagent 事件原位更新——kimi 子代理块机制，实现原创） */
  agents?: AgentLine[]
  /** 错误出路提示（原型 12：错误码分类后的一行人话出路——与错误行同条目渲染） */
  errorHint?: string
  /** 流式进行中的 assistant 条目（appendStream 专属——防并发命令输出吞流/跨回合串流） */
  streaming?: boolean
}

export interface PendingApproval {
  id: number
  title: string
  command: string
  choices: Array<{ key: string; label: string }>
  selected: number
  /** 超时时刻（fail-closed 倒计时显示——原型 05 倒计时动画） */
  deadline?: number
  resolve(choice: string): void
}

export interface PendingClarify {
  id: number
  question: string
  choices: string[]
  selected: number
  resolve(answer: string): void
}

export interface PendingSecret {
  id: number
  kind: 'sudo' | 'secret'
  prompt: string
  masked: string
  resolve(value: string | null): void
}

/** 二次确认（原型 46/59：危险档切换等敏感项——默认否防手滑，crush quit.go 同族） */
export interface PendingConfirm {
  id: number
  message: string
  danger: boolean
  choices: Array<{ key: string; label: string }>
  selected: number
  resolve(key: string): void
}

/** 压缩三选（原型 32：上下文超阈值——回合暂停征求；超时回退 auto 现行为） */
export interface PendingCompact {
  id: number
  used: number
  limit: number
  ratio: number
  choices: Array<{ key: string; label: string; desc: string }>
  selected: number
  resolve(key: 'micro' | 'full' | 'none' | 'auto'): void
}

/** 计划提案（原型 06：plan 模式回合产出计划文本 → 批准/编辑/返回——批准前零副作用由内核零工具闸保证） */
export interface PendingPlan {
  id: number
  text: string
  selected: number
  resolve(choice: 'approve' | 'edit' | 'cancel'): void
}

/** 计划编辑（原型 06 E 编辑计划：多行编辑后按修改执行） */
export interface PendingPlanEdit {
  id: number
  text: string
  resolve(edited: string | null): void
}

export interface TuiState {
  booted: boolean
  lang: 'zh' | 'en'
  mode: string
  model: string
  cwd: string
  gitBranch: string | null
  /** agent 回合运行中（输入区切双通道） */
  running: boolean
  /** thinking 心跳行（耗时/token 数——降噪规则 9：不渲染正文） */
  thinkingMs: number
  thinkingToks: number
  entries: ChatEntry[]
  /** 运行中 Enter 排队（kimi 双通道——原型 03） */
  queue: string[]
  overlay:
    | { kind: 'none' }
    | { kind: 'approval'; pending: PendingApproval }
    | { kind: 'clarify'; pending: PendingClarify }
    | { kind: 'secret'; pending: PendingSecret }
    | { kind: 'confirm'; pending: PendingConfirm }
    | { kind: 'compact'; pending: PendingCompact }
    | { kind: 'plan'; pending: PendingPlan }
    | { kind: 'planedit'; pending: PendingPlanEdit }
    | { kind: 'help' }
    | { kind: 'model' }
    | { kind: 'theme' }
    | { kind: 'config' }
    | { kind: 'modelform' }
    | { kind: 'mode' }
    | { kind: 'keys' }
    | { kind: 'rewind' }
    | { kind: 'voice' }
  /** 输入框状态（value 入 store：App 依此计算底部固定区行数——钉底机制的数据源） */
  composer: { value: string; slashSel: number }
  /** 转录视口：pinnedLine = 顶锚定行号（null = 贴底跟随——新内容到达即贴底）。
   *  顶锚定 = 上翻阅读时视口冻结：流式新内容只计入 ↓ 标记，不推走当前视口（kimi/codex 同行为） */
  scroll: { pinnedLine: number | null }
  /** 后台任务活跃集（原型 13：状态栏 ▣ 计数常驻；完成自动回流通知） */
  tasks: Array<{ id: string; kind: string; goal: string }>
  /** 回合阶段（原型 04：agent.stage 心跳行——与 thinking 共用一行，零额外行数） */
  stage: string
  /** 命令执行心跳（长命令如 /build 数分钟——转录区一行「◈ 执行 …」；null = 无命令在跑） */
  command: { text: string; ms: number } | null
  /** 当前主题（原型 31：四主题色板名） */
  themeName: string
  /** 「独立艺术品」品牌（ConfigService.resolveBranding——Header 品牌行/欢迎语；null = 默认 wxnodus） */
  brand: { name: string; icon: string | null } | null
  /** 上下文水位（原型 26/32：usage_stats 实时 SUM + 模型 maxContext——阈值 0.85 变紫） */
  context: { used: number; limit: number } | null
  /** 重连进度（原型 12：agent.retry 结构化事件——心跳行实时倒数「重连上游 第 n/m 次」） */
  retry: { attempt: number; max: number; delayMs: number; at: number } | null
  /** 语音会话（原型 34：录音/转写状态——录音秒数由 1s tick 驱动） */
  voice: { state: 'off' | 'recording' | 'transcribing'; seconds: number }
  placeholderIdx: number
  exitHint: boolean
}

export const initialTuiState = (): TuiState => ({
  booted: false,
  lang: 'zh',
  mode: 'smart',
  model: '',
  cwd: '',
  gitBranch: null,
  running: false,
  thinkingMs: 0,
  thinkingToks: 0,
  entries: [],
  queue: [],
  overlay: { kind: 'none' },
  composer: { value: '', slashSel: 0 },
  scroll: { pinnedLine: null },
  tasks: [],
  stage: '',
  command: null,
  themeName: 'deepspace',
  brand: null,
  context: null,
  retry: null,
  voice: { state: 'off', seconds: 0 },
  placeholderIdx: 0,
  exitHint: false,
})

export class TuiStore {
  private state: TuiState = initialTuiState()
  private listeners = new Set<() => void>()
  private nextId = 1
  /** 转录上限（防无限增长——超限折叠最旧段） */
  private static MAX_ENTRIES = 400

  getSnapshot = (): TuiState => this.state
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  id(): number { return this.nextId++ }

  patch(part: Partial<TuiState>): void {
    this.state = { ...this.state, ...part }
    for (const fn of this.listeners) fn()
  }

  /** 输入框值（App 底栏行数预算据此计算——钉底依赖） */
  setComposerValue(value: string): void {
    this.patch({ composer: { ...this.state.composer, value } })
  }

  setComposerSel(slashSel: number): void {
    this.patch({ composer: { ...this.state.composer, slashSel } })
  }

  /** 顶锚定行号（↑/PgUp 上翻；null 恢复贴底跟随——视口冻结核心） */
  setPinnedLine(line: number | null): void {
    this.patch({ scroll: { pinnedLine: line === null ? null : Math.max(0, line) } })
  }

  /** 贴底（发送/排队/面板关闭/视图重建时调用——用户裁决：焦点必回输入区） */
  scrollToBottom(): void {
    this.patch({ scroll: { pinnedLine: null } })
  }

  push(entry: ChatEntry): void {
    const entries = [...this.state.entries, entry]
    if (entries.length > TuiStore.MAX_ENTRIES) {
      // 降噪规则 2 同族：最旧段折叠为一行计数（+N 条）
      const dropped = entries.length - TuiStore.MAX_ENTRIES
      entries.splice(0, dropped, { kind: 'fold', fold: { label: `… 前 ${dropped} 条已滚动折叠（/logs 可溯）`, lines: [] } })
    }
    this.patch({ entries })
  }

  /** 更新最近一条 tool entry（start→complete 同 id 复用） */
  patchTool(id: string, part: Partial<ToolEntry>): void {
    const entries = this.state.entries.map(e =>
      e.kind === 'tool' && e.tool?.id === id ? { ...e, tool: { ...e.tool, ...part } } : e)
    this.patch({ entries })
  }

  /** 子代理行原位更新（同 id 复用；无编排块则新建——原型 23 状态点流转） */
  patchAgent(id: string, line: Partial<AgentLine>): void {
    const entries = [...this.state.entries]
    let idx = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.kind === 'agents') { idx = i; break }
    }
    if (idx < 0) {
      entries.push({ kind: 'agents', agents: [{ id, goal: '', phase: 'run', ...line }] })
    } else {
      const block = entries[idx]!
      const list = [...(block.agents ?? [])]
      const at = list.findIndex(a => a.id === id)
      if (at >= 0) list[at] = { ...list[at]!, ...line }
      else list.push({ id, goal: '', phase: 'run', ...line })
      entries[idx] = { ...block, agents: list }
    }
    this.patch({ entries })
  }

  /** 后台任务计数（jobs.created/complete → 原型 13 状态栏 ▣） */
  setTask(id: string, task: { kind: string; goal: string } | null): void {
    const tasks = task === null
      ? this.state.tasks.filter(t => t.id !== id)
      : [...this.state.tasks.filter(t => t.id !== id), { id, kind: task.kind, goal: task.goal }]
    this.patch({ tasks })
  }

  /** 当前流式 assistant 行尾追加文本（kimi 已确认块落屏模式——只动本回合流式条目；
   *  streaming 标记防串流：并发命令输出/跨回合的 assistant 条目不会被续写） */
  appendStream(text: string): void {
    const entries = [...this.state.entries]
    const last = entries[entries.length - 1]
    if (last?.kind === 'assistant' && last.streaming === true) entries[entries.length - 1] = { ...last, text: (last.text ?? '') + text }
    else entries.push({ kind: 'assistant', text, streaming: true })
    this.patch({ entries })
  }

  /** 流式条目收口（回合结束/新回合开始——去掉 streaming 标记，防跨回合串流） */
  sealStream(): void {
    const entries = this.state.entries
    const last = entries[entries.length - 1]
    if (last?.kind === 'assistant' && last.streaming === true) {
      entries[entries.length - 1] = { kind: 'assistant', text: last.text ?? '' }
      this.patch({ entries })
    }
  }

  /** 回合开始：清 thinking 心跳、标记运行 */
  beginTurn(): void {
    this.patch({ running: true, thinkingMs: 0, thinkingToks: 0 })
  }

  endTurn(): void {
    // thinking 结束收成单行（降噪规则 9：Thought for Xs）
    const s = this.state
    this.sealStream() // 流式条目收口（防跨回合串流）
    if (s.thinkingMs > 0) {
      this.push({ kind: 'notice', text: `· Thought for ${Math.round(s.thinkingMs / 1000)}s · ${s.thinkingToks} tokens` })
    }
    this.patch({ running: false, thinkingMs: 0, thinkingToks: 0, stage: '', retry: null })
    // 队列首发（kimi 双通道：运行结束后自动发送）
    const [next, ...rest] = s.queue
    if (next !== undefined) {
      this.patch({ queue: rest })
      // 由 runtime 监听 queueDrain 时机——此处仅出队，发送由 consumer 处理
      this.pendingSend = next
    }
  }

  /** 待发送的出队消息（endTurn 后 runtime 取走） */
  pendingSend: string | null = null
}
