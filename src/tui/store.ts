// src/tui/store.ts — 自研轻量响应 store（零依赖：getSnapshot/subscribe/patch）
// useSyncExternalStore 友好；组件按 selector 订阅整树重渲（TUI 规模下整树渲染
// 足够快——wxnodus-ink 渲染管线自带帧合并）。
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

export interface ChatEntry {
  kind: 'user' | 'assistant' | 'notice' | 'error' | 'thinking' | 'tool' | 'fold'
  text?: string
  tool?: ToolEntry
  /** 折叠条（+N lines——精确计数） */
  fold?: { label: string; lines: string[] }
}

export interface PendingApproval {
  id: number
  title: string
  command: string
  choices: Array<{ key: string; label: string }>
  selected: number
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
    | { kind: 'help' }
  slashMenu: { open: boolean; filter: string; selected: number }
  placeholderIdx: number
  tipIdx: number
  statusNote: string
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
  slashMenu: { open: false, filter: '', selected: 0 },
  placeholderIdx: 0,
  tipIdx: 0,
  statusNote: '',
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

  /** 当前流式 assistant 行尾追加文本（kimi 已确认块落屏模式——流式只动最后一条） */
  appendStream(text: string): void {
    const entries = [...this.state.entries]
    const last = entries[entries.length - 1]
    if (last?.kind === 'assistant') entries[entries.length - 1] = { kind: 'assistant', text: (last.text ?? '') + text }
    else entries.push({ kind: 'assistant', text })
    this.patch({ entries })
  }

  /** 回合开始：清 thinking 心跳、标记运行 */
  beginTurn(): void {
    this.patch({ running: true, thinkingMs: 0, thinkingToks: 0 })
  }

  endTurn(): void {
    // thinking 结束收成单行（降噪规则 9：Thought for Xs）
    const s = this.state
    if (s.thinkingMs > 0) {
      this.push({ kind: 'notice', text: `· Thought for ${Math.round(s.thinkingMs / 1000)}s · ${s.thinkingToks} tokens` })
    }
    this.patch({ running: false, thinkingMs: 0, thinkingToks: 0 })
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
