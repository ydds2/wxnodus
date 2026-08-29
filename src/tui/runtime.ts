// src/tui/runtime.ts — TUI 运行时：bus 事件→store、bridges 回调面（审批/澄清/密钥）、
// 回合发送（agent.run）、双通道队列、退出保护。全自研（原型 56 联动图谱的实现侧）。
import { TuiStore, type PendingApproval, type PendingClarify, type PendingSecret } from './store.js'
import { glyphs } from './termcap.js'

export interface TuiRuntimeDeps {
  store: TuiStore
  bus: { on(type: string, fn: (e: any) => void): () => void }
  agent: {
    run(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; text: string; turns: number; interrupted?: boolean }>
    abort(): void
    steer(text: string): boolean
    setMode?(mode: string): void
  }
  commandBus: { execute(cmd: string, ctx?: unknown): Promise<unknown> }
  config: { get(path: string): Record<string, any> }
  cwd: string
  gitBranch?: () => string | null
  /** 审批超时（fail-closed——KF-010 同语义；默认 5 分钟人在回路） */
  approvalTimeoutMs?: number
  onRequestExit(): void
}

/** 工具调用的一行摘要（降噪规则 1：名 + 1 个关键参数——kimi extract_key_argument 同思路） */
export function toolSummary(name: string, args: Record<string, any>): string {
  void name
  const cmd = typeof args?.command === 'string' && args.command ? args.command
    : typeof args?.path === 'string' && args.path ? String(args.path)
    : typeof args?.query === 'string' && args.query ? String(args.query).slice(0, 60)
    : typeof args?.pattern === 'string' && args.pattern ? String(args.pattern)
    : ''
  return String(cmd).slice(0, 80)
}

/** 输出降噪规则 3：head 5 + tail 5 + 精确计数省略行 */
export function clampOutput(text: string, head = 5, tail = 5): string {
  const lines = text.replace(/\r/g, '').split('\n')
  if (lines.length <= head + tail + 1) return text
  const omitted = lines.length - head - tail
  return [...lines.slice(0, head), `… +${omitted} lines · Enter 展开`, ...lines.slice(-tail)].join('\n')
}

export class TuiRuntime {
  readonly store: TuiStore
  private deps: TuiRuntimeDeps
  private offs: Array<() => void> = []
  private ac: AbortController | null = null
  private thinkTimer: NodeJS.Timeout | null = null
  private timers: NodeJS.Timeout[] = []
  private exiting = false

  constructor(deps: TuiRuntimeDeps) {
    this.deps = deps
    this.store = deps.store
  }

  start(): void {
    const s = this.store
    const settings = (this.deps.config.get('settings') ?? {}) as Record<string, any>
    s.patch({
      booted: true,
      mode: String(settings.mode ?? 'smart'),
      model: String(settings.model ?? '未配置'),
      cwd: this.deps.cwd,
      gitBranch: this.deps.gitBranch?.() ?? null,
      statusNote: '就绪',
    })
    this.wireBus()
    this.wireTimers()
    // 欢迎横幅（进入即第一屏——原 01 引导已删，配密钥走 /model）
    s.push({ kind: 'notice', text: 'WxNodus 就绪。/help 查看命令 · /model 配置模型 · 输入即对话' })
  }

  private wireBus(): void {
    const bus = this.deps.bus
    const store = this.store
    // 流式 token：assistant 行尾追加（kimi 已确认块落屏——只动最后一条）
    this.offs.push(bus.on('agent.token', (e: any) => {
      const text = String(e?.payload?.text ?? '')
      if (text) store.appendStream(text)
    }))
    // reasoning：不计入转录正文（降噪规则 9）——只驱动心跳计数
    this.offs.push(bus.on('reasoning.delta', (e: any) => {
      const text = String(e?.payload?.text ?? '')
      if (text) store.patch({ thinkingToks: store.getSnapshot().thinkingToks + 1 })
    }))
    // 工具生命周期：start 一行 → complete 收敛（Using→Used）
    this.offs.push(bus.on('agent.tool', (e: any) => {
      const p = e?.payload ?? {}
      const id = String(p.toolId ?? '')
      if (p.phase === 'start') {
        store.push({ kind: 'tool', tool: { id, name: String(p.name ?? ''), summary: toolSummary(String(p.name ?? ''), p.args ?? {}), phase: 'run' } })
      } else {
        store.patchTool(id, { phase: p.ok === false ? 'fail' : 'done', ms: Number(p.ms) || 0, detail: p.resultText ? clampOutput(String(p.resultText)) : undefined })
      }
    }))
    this.offs.push(bus.on('system.notice', (e: any) => {
      const text = String(e?.payload?.text ?? '')
      if (text) store.push({ kind: 'notice', text })
    }))
    this.offs.push(bus.on('agent.error', (e: any) => {
      store.push({ kind: 'error', text: String(e?.payload?.message ?? '未知错误') })
    }))
  }

  private wireTimers(): void {
    // thinking 心跳计时 + placeholder/tip 轮换（3.2s/30s——kimi 底栏节奏）
    this.timers.push(setInterval(() => {
      const s = this.store.getSnapshot()
      if (s.running) this.store.patch({ thinkingMs: s.thinkingMs + 1000 })
    }, 1000))
    this.timers.push(setInterval(() => {
      const s = this.store.getSnapshot()
      this.store.patch({ placeholderIdx: (s.placeholderIdx + 1) % 5, tipIdx: (s.tipIdx + 1) % 5 })
    }, 3200))
  }

  /** 用户提交（空闲=发送；运行中=排队——kimi 双通道） */
  submit(text: string): void {
    const input = text.trim()
    if (!input) return
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'help') { this.store.patch({ overlay: { kind: 'none' } }); return }
    if (input.startsWith('/')) { void this.runCommand(input); return }
    if (s.running) {
      this.store.patch({ queue: [...s.queue, input] })
      this.store.push({ kind: 'notice', text: `${glyphs().queued} 已排队（${this.store.getSnapshot().queue.length} 条）——运行结束自动发送 · ↑ 召回` })
      return
    }
    void this.send(input)
  }

  /** steer：运行中即时注入（Ctrl+S——kimi 双通道第二通道） */
  steer(text: string): void {
    const input = text.trim()
    if (!input) return
    const ok = this.deps.agent.steer(input)
    this.store.push({ kind: 'notice', text: ok ? `⇄ 已注入当前回合：${input.slice(0, 60)}` : '当前无运行回合，改走发送' })
    if (!ok) this.submit(input)
  }

  private async send(prompt: string): Promise<void> {
    const store = this.store
    store.push({ kind: 'user', text: prompt })
    store.beginTurn()
    this.ac = new AbortController()
    try {
      const r = await this.deps.agent.run(prompt, { signal: this.ac.signal })
      if (r.text && store.getSnapshot().entries[store.getSnapshot().entries.length - 1]?.kind !== 'assistant') {
        store.push({ kind: 'assistant', text: r.text })
      }
      if (!r.ok) store.push({ kind: 'error', text: r.text || '回合未成功' })
    } catch (e: any) {
      store.push({ kind: 'error', text: String(e?.message ?? e).slice(0, 200) })
    } finally {
      this.ac = null
      store.endTurn()
      // 队列续发（endTurn 出队 pendingSend）
      const next = store.pendingSend
      store.pendingSend = null
      if (next && !this.exiting) { this.store.push({ kind: 'notice', text: `→ 发送排队消息：${next.slice(0, 50)}` }); void this.send(next) }
    }
  }

  private async runCommand(cmd: string): Promise<void> {
    const store = this.store
    store.push({ kind: 'user', text: cmd })
    try {
      const out = await this.deps.commandBus.execute(cmd)
      const r = out as { ok?: boolean; output?: string; error?: unknown } | string
      const text = typeof r === 'string' ? r : String(r?.output ?? r?.error ?? '')
      if (text) store.push({ kind: 'assistant', text })
      const settings = (this.deps.config.get('settings') ?? {}) as Record<string, any>
      store.patch({ mode: String(settings.mode ?? store.getSnapshot().mode), model: String(settings.model ?? store.getSnapshot().model) })
    } catch (e: any) {
      store.push({ kind: 'error', text: `命令失败：${String(e?.message ?? e).slice(0, 160)}` })
    }
  }

  /** Esc：运行中=中断；输入框=清空；帮助=关闭（退出保护三层——原型 30） */
  esc(): boolean {
    const s = this.store.getSnapshot()
    if (s.overlay.kind !== 'none' && s.overlay.kind !== 'help') return false // 浮层组件自处理
    if (s.overlay.kind === 'help') { this.store.patch({ overlay: { kind: 'none' } }); return true }
    if (s.running) {
      this.ac?.abort()
      this.deps.agent.abort()
      this.store.push({ kind: 'notice', text: '|| 已中断当前回合（会话保留，队列保留）' })
      return true
    }
    return false
  }

  /** Ctrl+C 退出保护：运行中先中断；空闲首按提示；二按退出 */
  sigint(): void {
    const s = this.store.getSnapshot()
    if (s.running) { this.esc(); this.store.push({ kind: 'notice', text: '再按 Ctrl+C 退出 wxnodus' }); return }
    if (this.exiting) { this.dispose(); this.deps.onRequestExit(); return }
    this.exiting = true
    this.store.patch({ exitHint: true })
    setTimeout(() => { this.exiting = false; this.store.patch({ exitHint: false }) }, 2000)
  }

  // ── bridges 回调面（cli/index.ts let gateway 中介消费——全自研替代 headless wire）──

  requestApproval(name: string, args: Record<string, unknown>): Promise<'allow' | 'session' | 'deny'> {
    return new Promise(resolve => {
      const s = this.store
      const pending: PendingApproval = {
        id: s.id(),
        title: `工具调用审批：${name}`,
        command: toolSummary(name, args as Record<string, any>) || name,
        choices: [
          { key: 'allow', label: '仅本次允许' },
          { key: 'session', label: '本会话允许同类' },
          { key: 'always', label: '永久允许此模式（/perm 可撤）' },
          { key: 'deny', label: '拒绝' },
        ],
        selected: 0,
        resolve: choice => { this.store.patch({ overlay: { kind: 'none' } }); resolve(choice as 'allow' | 'session' | 'deny') },
      }
      s.patch({ overlay: { kind: 'approval', pending } })
      // 超时 fail-closed（KF-010 同语义）
      const timeout = setTimeout(() => {
        if (this.store.getSnapshot().overlay.kind === 'approval') {
          this.store.push({ kind: 'notice', text: `⚠ 审批超时已拒绝：${name}（fail-closed）` })
          pending.resolve('deny')
        }
      }, this.deps.approvalTimeoutMs ?? 300_000)
      this.timers.push(timeout)
    })
  }

  requestClarify(question: string, choices?: string[]): Promise<string> {
    return new Promise(resolve => {
      const pending: PendingClarify = {
        id: this.store.id(),
        question,
        choices: choices ?? [],
        selected: 0,
        resolve: answer => { this.store.patch({ overlay: { kind: 'none' } }); resolve(answer) },
      }
      this.store.patch({ overlay: { kind: 'clarify', pending } })
    })
  }

  requestSecretInput(kind: 'sudo' | 'secret', prompt: string, name?: string): Promise<string | null> {
    return new Promise(resolve => {
      const pending: PendingSecret = {
        id: this.store.id(),
        kind,
        prompt: name ? `${prompt}（${name}）` : prompt,
        masked: '',
        resolve: value => { this.store.patch({ overlay: { kind: 'none' } }); resolve(value) },
      }
      this.store.patch({ overlay: { kind: 'secret', pending } })
    })
  }

  requestCredentialForm(): Promise<Record<string, string> | null> {
    // 表单场景（原型 58）后续批次——当前诚实降级为 null（工具拒绝并提示）
    return Promise.resolve(null)
  }

  toggleHelp(): void {
    const kind = this.store.getSnapshot().overlay.kind
    this.store.patch({ overlay: kind === 'help' ? { kind: 'none' } : { kind: 'help' } })
  }

  /** 展开/收起工具详情（Ctrl+T 全局 / Enter 单条——原型 54） */
  toggleToolDetail(): void {
    const entries = this.store.getSnapshot().entries.map(e =>
      e.kind === 'tool' && e.tool ? { ...e, tool: { ...e.tool, expanded: !e.tool.expanded } } : e)
    this.store.patch({ entries })
  }

  dispose(): void {
    for (const off of this.offs) { try { off() } catch { /* 已退订 */ } }
    for (const t of this.timers) clearTimeout(t)
    this.offs = []
    this.timers = []
    if (this.thinkTimer) { clearInterval(this.thinkTimer); this.thinkTimer = null }
    this.ac?.abort()
  }
}
