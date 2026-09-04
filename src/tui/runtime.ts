// src/tui/runtime.ts — TUI 运行时：bus 事件→store、bridges 回调面（审批/澄清/密钥/确认）、
// 回合发送（agent.run）、双通道队列、退出保护、配置面板/表单/历史落盘。全自研（原型 56 联动图谱的实现侧）。
// 事件消费：agent.token/reasoning/tool/subagent/stage · jobs.created/complete · system.notice/agent.error。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { TuiStore, type PendingApproval, type PendingClarify, type PendingSecret, type PendingConfirm, type PendingCompact, type PendingPlan, type PendingPlanEdit, type ChatEntry } from './store.js'
import { glyphs } from './termcap.js'
import { setTuiTheme } from './theme.js'
import { initTuiLang, tuiT } from './i18n.js'
import { touchCommand } from './commands.js'

export interface TuiRuntimeDeps {
  store: TuiStore
  bus: { on(type: string, fn: (e: any) => void): () => void }
  agent: {
    run(prompt: string, opts?: {
      signal?: AbortSignal
      maxContextTokens?: number
      onCompactChoice?: (info: { used: number; ctxLimit: number; compactAt: number }) => Promise<'micro' | 'full' | 'none' | 'auto'>
    }): Promise<{ ok: boolean; text: string; turns: number; interrupted?: boolean }>
    abort(): void
    steer(text: string): boolean
    setMode?(mode: string): void
  }
  commandBus: { execute(cmd: string, ctx?: unknown): Promise<unknown> }
  config: { get(path: string): Record<string, any> }
  /** 首启向导 locale（dataDir/config.json——settings.lang 缺省时的语言回退） */
  localeFallback?: string
  cwd: string
  gitBranch?: () => string | null
  /** 模型目录（原型 08 选择器数据源——kernel MODEL_CATALOG 经 cli 注入） */
  modelCatalog?: () => Array<{ id: string; name: string; provider: string }>
  /** 设置窄写口（原型 31 主题改即存——settings 单一写路径；布尔项存布尔，字符串项存字符串） */
  setSetting?: (key: string, value: string | boolean) => void
  /** 输入历史落盘路径（原型 29 持久化——G5；未提供则进程内栈） */
  historyFile?: () => string
  /** 上下文水位（原型 26/32：usage_stats SUM + maxContext——经 cli 窄端注入，TUI 不直连 DB） */
  contextUsage?: () => { used: number; limit: number } | null
  /** 命令全景索引（原型 53：registry COMMAND_DESC/CAT——经 cli 窄端注入） */
  commandIndex?: () => Array<{ cmd: string; desc: string; cat: string }>
  /** 端点探测（原型 58 测试连接：GET /models + SSRF 防护——网络归 cli，TUI 零网络） */
  probeEndpoint?: (baseURL: string, apiKey: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>
  /** 会话用户消息时间线（原型 28 回滚面板——messages 表只读查询经 cli 窄端注入） */
  sessionMessages?: () => Array<{ runNo: number; ts: number; preview: string }>
  /** 当前会话 id（/resume 等命令切换会话后视图同步检测——经 cli 窄端注入） */
  sessionId?: () => string
  /** 当前会话最近转录（user/assistant——/resume 视图重建数据源；TUI 不直连 DB） */
  sessionTranscript?: () => Array<{ role: string; text: string }>
  /** 「独立艺术品」品牌化（name/icon——ConfigService 解析结果经 cli 窄端注入） */
  branding?: () => { name: string; icon: string | null } | null
  /** 语音管线（原型 34：录音/转写/播报——ffmpeg+whisper/SAPI 全链在 kernel，TUI 零媒体处理） */
  voice?: {
    available(): boolean
    start(): Promise<{ ok: boolean; error?: string }>
    stop(): Promise<{ ok: boolean; text?: string; error?: string }>
    cancel(): void
    speak(text: string): boolean
  }
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

/**
 * 错误分类 → 一行出路提示（原型 12「错误码+人话原因+三条出路」的 TUI 侧部分落地——
 * 机械关键词分类，零 LLM；重试进度经 agent.retry 结构化事件落地（心跳行倒数——T34 销项）。
 */
export function classifyError(message: string): { kind: string; hint: string } {
  const m = message.toLowerCase()
  if (/(未配置|api[-_ ]?key|密钥|需要.*配置|unauthorized|无可用模型|key 校验)/.test(m)) {
    return { kind: 'config', hint: tuiT('tui.err.config') }
  }
  if (/(timeout|timed|604|408|429|5\d\d|econn|enotfound|网络|超时|上游)/.test(m)) {
    return { kind: 'network', hint: tuiT('tui.err.network') }
  }
  if (/(loop|循环|重复调用|打转|无进展)/.test(m)) {
    return { kind: 'loop', hint: tuiT('tui.err.loop') }
  }
  if (/(未知工具|unknown tool|连续失败)/.test(m)) {
    return { kind: 'tools', hint: tuiT('tui.err.tools') }
  }
  if (/(余额|quota|额度|insufficient|balance)/.test(m)) {
    return { kind: 'quota', hint: tuiT('tui.err.quota') }
  }
  return { kind: 'unknown', hint: tuiT('tui.err.unknown') }
}

/** 输出降噪规则 3：head 5 + tail 5 + 精确计数省略行 */
export function clampOutput(text: string, head = 5, tail = 5): string {
  const lines = text.replace(/\r/g, '').split('\n')
  if (lines.length <= head + tail + 1) return text
  const omitted = lines.length - head - tail
  return [...lines.slice(0, head), tuiT('tui.transcript.expandHint', { n: omitted }), ...lines.slice(-tail)].join('\n')
}

export class TuiRuntime {
  readonly store: TuiStore
  private deps: TuiRuntimeDeps
  private offs: Array<() => void> = []
  private ac: AbortController | null = null
  /** 命令等待的中断控制器（Esc 打断长命令等待——与 agent 回合的 ac 分离，互不误伤） */
  private cmdAc: AbortController | null = null
  private thinkTimer: NodeJS.Timeout | null = null
  private timers: NodeJS.Timeout[] = []
  private exiting = false
  /** 输入历史（Ctrl+↑↓ 召回——原型 29 输入增强：gemini keyBindings 历史导航机制，实现原创） */
  private history: string[] = []
  private histCursor = -1
  /** 历史落盘防抖句柄（500ms 合并——连续提交只写一次） */
  private historySaveTimer: NodeJS.Timeout | null = null
  private static HISTORY_CAP = 200
  /** 跟踪的当前会话 id（start 捕获；命令执行后比对——/resume 切换即视图重建） */
  private sessionId = ''
  /** Esc 中断后的队列暂留态（2s 窗口：再按 Esc 清空，超时自动续发——队列不再"停不下来"） */
  private queuePaused = false
  private pauseUntil = 0
  private pausedNext: string | null = null
  private resumeTimer: NodeJS.Timeout | null = null
  /** 第二按 Esc 已清空——让尚未收尾的 finally 丢弃 pendingSend（endTurn 已出队的竞态防护） */
  private clearedQueued = false
  /** goal 模式末轮已由流式落屏（agent.goal done/cancelled 时置位）——send 回传不再重复推全文 */
  private goalStreamDone = false

  constructor(deps: TuiRuntimeDeps) {
    this.deps = deps
    // C-5 i18n：语言源两级——settings.lang（/lang 运行时切换，优先）→ 首启向导 locale
    // （dataDir/config.json · preBootstrap 持久化；批次ⅩⅩⅤ 修复：向导选 English 后 TUI 同语言启动）
    initTuiLang(() => {
      const sl = String((deps.config.get('settings') ?? {} as Record<string, unknown>)?.lang)
      if (sl === 'en' || sl === 'zh-CN') return sl
      return String((deps as { localeFallback?: string }).localeFallback) === 'en' ? 'en' : 'zh-CN'
    })
    this.store = deps.store
  }

  start(): void {
    const s = this.store
    const settings = (this.deps.config.get('settings') ?? {}) as Record<string, any>
    // 主题启动装载（原型 31：设置持久化 settings.tuiTheme——未知名回退深空）
    const theme = setTuiTheme(String(settings.tuiTheme ?? 'deepspace'))
    s.patch({
      booted: true,
      mode: String(settings.mode ?? 'smart'),
      model: String(settings.model ?? ''), // 空=未配置——渲染层经 tuiT 兜底（/lang 即切）
      cwd: this.deps.cwd,
      gitBranch: this.deps.gitBranch?.() ?? null,
      themeName: theme,
      brand: this.deps.branding?.() ?? null,
    })
    this.wireBus()
    this.wireTimers()
    this.loadHistory()
    this.refreshContext()
    this.sessionId = this.deps.sessionId?.() ?? ''
    // 启动视图重建：自动恢复的会话携带历史 → 转录直接展示（/resume 同口径——视图即真实）
    const brandName = this.store.getSnapshot().brand?.name ?? 'WxNodus'
    const welcome: ChatEntry = { kind: 'notice', text: tuiT('tui.runtime.welcome', { brand: brandName }) }
    const history: ChatEntry[] = []
    for (const m of (this.deps.sessionTranscript?.() ?? []).slice(-40)) {
      const text = String(m.text ?? '').trimEnd().slice(0, 3000)
      if (text) history.push({ kind: m.role === 'user' ? 'user' : 'assistant', text })
    }
    if (history.length > 0) {
      this.store.patch({ entries: [welcome, ...history] })
      this.store.push({ kind: 'notice', text: tuiT('tui.runtime.sessionRestored', { sid: this.sessionId.slice(0, 8), n: history.length }) })
    } else {
      s.push(welcome) // 欢迎横幅（进入即第一屏——原 01 引导已删，配密钥走 /model）
    }
  }

  /** 上下文水位刷新（原型 26：启动/回合结束/30s 心跳——usage_stats 实时 SUM 经窄端注入） */
  refreshContext(): void {
    const raw = this.deps.contextUsage?.() ?? null
    if (!raw) { this.store.patch({ context: null }); return }
    const used = Math.max(0, Math.round(Number(raw.used) || 0))
    const limit = Math.max(1, Math.round(Number(raw.limit) || 65536))
    this.store.patch({ context: { used, limit } })
  }

  /** 命令全景索引（原型 53 数据源——registry 单一事实来源经窄端注入） */
  commandIndex(): Array<{ cmd: string; desc: string; cat: string }> {
    return this.deps.commandIndex?.() ?? []
  }

  // ── 输入历史落盘（原型 29 · G5：跨会话召回——gemini/aider 历史持久化机制，实现原创）──

  private loadHistory(): void {
    const file = this.deps.historyFile?.()
    if (!file) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v?: number; items?: unknown }
      if (Array.isArray(parsed.items)) {
        this.history = parsed.items.filter((x): x is string => typeof x === 'string').slice(-TuiRuntime.HISTORY_CAP)
      }
    } catch { /* 首启/损坏——进程内栈起步，零崩溃 */ }
  }

  private scheduleHistorySave(): void {
    if (!this.deps.historyFile) return
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer)
    this.historySaveTimer = setTimeout(() => this.flushHistory(), 500)
  }

  /** 落盘（防抖合并；原子性：先写 tmp 语义以单次 writeFileSync 为准——小文件足够） */
  flushHistory(): void {
    if (this.historySaveTimer) { clearTimeout(this.historySaveTimer); this.historySaveTimer = null }
    const file = this.deps.historyFile?.()
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ v: 1, items: this.history.slice(-TuiRuntime.HISTORY_CAP) }), 'utf8')
    } catch { /* 落盘失败静默——内存栈仍在，绝不影响主流程 */ }
  }

  private wireBus(): void {
    const bus = this.deps.bus
    const store = this.store
    // 流式 token：合并缓冲（50ms 合批——Live 限帧，kimi 10fps 同族），落屏仍只动最后一条
    this.offs.push(bus.on('agent.token', (e: any) => {
      // 会话过滤（A25 对齐）：子代理 token（<主>:sub）不落主转录——此前混入主面板
      const sid = String(e?.payload?.session_id ?? '')
      if (sid && sid !== this.sessionId) return
      const text = String(e?.payload?.text ?? '')
      if (text) {
        this.streamBuf += text
        if (!this.streamTimer) {
          this.streamTimer = setTimeout(() => { this.flushStream() }, 50)
          this.timers.push(this.streamTimer)
        }
      }
      // 重试流重置（kernel 契约：清空失败尝试的半截输出再接收重试全文——杜绝「半截旧文+完整新文」拼接）
      if (e?.payload?.reset === true) {
        this.flushStream()
        store.patch({ retry: null }) // 重连心跳退场（新一轮 token 即将到达）
        this.dropCurrentAttempt()
      }
    }))
    // 重连进度（原型 12）：agent.retry 结构化事件 → 心跳行实时倒数
    this.offs.push(bus.on('agent.retry', (e: any) => {
      // N4（批次ⅩⅩⅦ）：会话过滤——子代理重连倒数不落主心跳（kernel 已补 session_id）
      const sid = String(e?.payload?.session_id ?? '')
      if (sid && sid !== this.sessionId) return
      const p = e?.payload ?? {}
      store.patch({
        retry: {
          attempt: Math.max(1, Number(p.attempt) || 1),
          max: Math.max(1, Number(p.max) || 3),
          delayMs: Math.max(0, Number(p.delayMs) || 0),
          at: Date.now(),
        },
      })
    }))
    // reasoning：不计入转录正文（降噪规则 9）——只驱动心跳计数；子代理 reasoning 不计数（会话过滤）
    this.offs.push(bus.on('reasoning.delta', (e: any) => {
      const sid = String(e?.payload?.session_id ?? '')
      if (sid && sid !== this.sessionId) return
      const text = String(e?.payload?.text ?? '')
      if (text) store.patch({ thinkingToks: store.getSnapshot().thinkingToks + 1 })
    }))
    // 工具生命周期：start 一行 → complete 收敛（Using→Used）；子代理工具不入主面板（A25 会话标记过滤）
    this.offs.push(bus.on('agent.tool', (e: any) => {
      const p = e?.payload ?? {}
      const sid = String(p.session_id ?? '')
      if (sid && sid !== this.sessionId) return
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
      // N4（批次ⅩⅩⅦ）：会话过滤——子代理错误不落主转录（kernel 已补 session_id）
      const esid = String(e?.payload?.session_id ?? '')
      if (esid && esid !== this.sessionId) return
      const message = String(e?.payload?.message ?? '未知错误')
      const { hint } = classifyError(message)
      const retried = Number(e?.payload?.retries) > 0
      store.push({ kind: 'error', text: message, errorHint: retried ? `${hint} · 已自动重试 ${e.payload.retries} 次仍失败` : hint })
    }))
    // 子代理编排（原型 23）：start→运行行 · complete→终态原位更新（同 id 复用）
    this.offs.push(bus.on('agent.subagent', (e: any) => {
      const p = e?.payload ?? {}
      const id = String(p.subagent_id ?? p.session_id ?? `s${store.id()}`)
      const goal = String(p.goal ?? '').slice(0, 80)
      if (p.phase === 'start') {
        store.patchAgent(id, { goal, phase: 'run' })
      } else {
        store.patchAgent(id, { phase: p.ok === false ? 'fail' : 'done', turns: Number(p.turns) || 0 })
      }
    }))
    // 后台任务（原型 13）：活跃计数常驻状态栏；完成通知由 system.notice 回流（jobs.complete 自带）
    this.offs.push(bus.on('jobs.created', (e: any) => {
      const p = e?.payload ?? {}
      const id = String(p.id ?? `j${store.id()}`)
      store.setTask(id, { kind: String(p.kind ?? 'job'), goal: String(p.goal ?? '').slice(0, 60) })
    }))
    this.offs.push(bus.on('jobs.complete', (e: any) => {
      const p = e?.payload ?? {}
      const id = String(p.id ?? '')
      if (id) store.setTask(id, null)
    }))
    // 回合阶段（原型 04）：与 thinking 心跳共用一行（零额外行数——降噪）
    this.offs.push(bus.on('agent.stage', (e: any) => {
      const stage = String(e?.payload?.stage ?? '')
      if (stage) store.patch({ stage })
    }))
    // goal 模式轮次进度（Kimi Ralph 同款目标循环，实现原创）：轮间事件把流式缓冲收口成分轮块
    // （此前 N 轮输出拼接成一坨——轮界不可见）+ 一行轮次通知（零噪音）
    this.offs.push(bus.on('agent.goal', (e: any) => {
      const p = e?.payload ?? {}
      const round = Math.max(1, Number(p.round) || 1)
      const max = Math.max(1, Number(p.maxRounds) || 1)
      if (p.done === true) {
        this.flushStream() // 末轮已由流式落屏——send 回传不再重复推（goalStreamDone）
        this.goalStreamDone = true
        store.push({ kind: 'notice', text: `◆ goal 完成（${round} 轮）` })
      } else if (p.cancelled === true) {
        this.flushStream()
        this.goalStreamDone = true
        store.push({ kind: 'notice', text: `◆ goal 中断（第 ${round}/${max} 轮）` })
      } else if (round > 1) {
        this.flushStream() // 收口上一轮流式缓冲——分轮块
        store.push({ kind: 'notice', text: `◆ goal 第 ${round - 1}/${max} 轮完成 → 第 ${round} 轮` })
      }
    }))
  }

  private wireTimers(): void {
    // thinking 心跳计时 + placeholder 轮换（3.2s/1s——kimi 底栏节奏）；命令心跳同 tick 累计
    this.timers.push(setInterval(() => {
      const s = this.store.getSnapshot()
      if (s.running) this.store.patch({ thinkingMs: s.thinkingMs + 1000 })
      if (s.command) this.store.patch({ command: { ...s.command, ms: s.command.ms + 1000 } })
    }, 1000))
    this.timers.push(setInterval(() => {
      const s = this.store.getSnapshot()
      this.store.patch({ placeholderIdx: (s.placeholderIdx + 1) % 5 })
    }, 3200))
    // 上下文水位 30s 心跳（原型 26 水位呼吸——仅窄查询，TUI 不直连 DB）
    this.timers.push(setInterval(() => { this.refreshContext() }, 30_000))
  }

  /** 用户提交（空闲=发送；运行中=排队——kimi 双通道） */
  submit(text: string): void {
    const input = text.trim()
    if (!input) return
    const s = this.store.getSnapshot()
    // 历史入栈（连续重复去重——Ctrl+↑↓ 召回源）+ 防抖落盘（G5 跨会话）
    if (this.history[this.history.length - 1] !== input) {
      this.history.push(input)
      this.scheduleHistorySave()
    }
    this.histCursor = -1
    if (s.overlay.kind === 'help') { this.store.patch({ overlay: { kind: 'none' } }); return }
    if (input.startsWith('/')) {
      touchCommand(input) // 斜杠菜单频序上浮（kimi 按使用频次排序机制——菜单自适应个人习惯）
      // 原型 08：裸 /model 打开选择器（目录存在时）；带参走命令面（模糊切换）
      if (input.trim() === '/model' && this.deps.modelCatalog) { this.openModelPicker(); return }
      // 2026-09-03 用户裁决：裸 /perm 打开权限模式选择器（六档一览——模式唯一入口，热键已移除）；带参走命令面
      if (input.trim() === '/perm') { this.openModePicker(); return }
      // 原型 31：裸 /theme 打开主题选择器（改即存 + 实时预览）
      if (input.trim() === '/theme') { this.openThemePicker(); return }
      // 原型 59：裸 /config 打开配置面板（三控件交互）；带参走命令面
      if (input.trim() === '/config') { this.openConfigPanel(); return }
      // 原型 11：/help → 三页帮助面板（快捷/全景索引/联动图谱）；/help <命令> 走命令面
      if (input.trim() === '/help') { this.toggleHelp(); return }
      // 原型 30：/keys 快捷键速查（单一事实来源生成——零承诺漂移）
      if (input.trim() === '/keys') { this.openKeysPanel(); return }
      // 原型 28：/rewind 或裸 /undo → 回滚时间线（内核 /undo 命令面为执行体）
      if (input.trim() === '/rewind' || input.trim() === '/undo') { this.openRewindPanel(); return }
      // 原型 34：/voice → 语音对话（录音 → 转写 → 入输入框；全链在 kernel）
      if (input.trim() === '/voice') { void this.toggleVoiceRecording(); return }
      // 原型 33 附件通道：/paste → 剪贴板截图（落盘 + 视觉分析——kernel /img clipboard）
      if (input.trim() === '/paste') { void this.runCommand('/img clipboard'); return }
      // 原型 50：/clear 清屏（会话保留——转录视图即清，记忆/会话不丢）
      if (input.trim() === '/clear') { this.clearScreen(); return }
      // 会话切换视图一致性：/new 后转录视图清空（历史仍在 /sessions 与 Ctrl+↑↓ 历史）
      if (input.trim() === '/new') { void this.newSession(); return }
      void this.runCommand(input)
      return
    }
    this.store.scrollToBottom()
    if (s.running) {
      this.store.patch({ queue: [...s.queue, input] })
      this.store.push({ kind: 'notice', text: tuiT('tui.runtime.queueAdded', { glyph: glyphs().queued, n: this.store.getSnapshot().queue.length }) })
      return
    }
    void this.send(input)
  }

  /** Ctrl+↑↓ 历史召回（dir: -1 上一段 / +1 下一段；到最新再按 ↓ 回到编辑态返回空串） */
  recallHistory(dir: -1 | 1): string | null {
    if (this.history.length === 0) return null
    const n = this.history.length
    if (dir === -1) {
      const next = this.histCursor < 0 ? n - 1 : Math.max(0, this.histCursor - 1)
      this.histCursor = next
      return this.history[next]!
    }
    if (this.histCursor < 0) return null // 编辑态按 ↓：无操作
    const next = Math.min(n - 1, this.histCursor + 1)
    if (next === this.histCursor) {
      this.histCursor = -1 // 已到最新——回到编辑态
      return ''
    }
    this.histCursor = next
    return this.history[next]!
  }

  /** 打开模型选择器（原型 08——单面板原则：覆盖现有非阻塞浮层） */
  openModelPicker(): void {
    this.store.patch({ overlay: { kind: 'model' } })
  }

  closeModelPicker(): void {
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'model') this.store.patch({ overlay: { kind: 'none' } })
  }

  /** 选择器选中 → /model <id> 走命令面（模糊切换同链路——数据即通，不经确认页） */
  selectModel(id: string): void {
    this.closeModelPicker()
    this.store.scrollToBottom()
    void this.runCommand(`/model ${id}`)
  }

  modelCatalog(): Array<{ id: string; name: string; provider: string }> {
    return this.deps.modelCatalog?.() ?? []
  }

  // ── 模式档位（2026-09-03 用户裁决：全部由命令进入——单一选择器 /perm；热键不再切换档位）──

  /** 应用模式档：命令面写 + 状态即时刷新 + 零噪音通知（选择器/命令同走此唯一写路径） */
  async applyMode(mode: string): Promise<void> {
    try {
      await this.deps.commandBus.execute(`/perm ${mode}`)
    } catch { /* 切换失败降级：仅改显示（诚实性由下一次 /status 自证） */ }
    const settings = (this.deps.config.get('settings') ?? {}) as Record<string, any>
    this.store.patch({ mode: String(settings.mode ?? mode) })
    // yolo 进入时醒目提示（全放行档——仅显式选择，用户必须知道自己站在哪一档）
    this.store.push({ kind: 'notice', text: mode === 'yolo' ? `⚠ 模式：yolo（除硬红线全部放行——请确认这是你想要的安全档位）` : `◆ 模式：${mode}` })
  }

  /** 权限模式选择器：裸 /perm 打开——六档一览选择（2026-09-03：模式唯一入口） */
  openModePicker(): void {
    this.store.patch({ overlay: { kind: 'mode' } })
  }

  closeModePicker(): void {
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'mode') this.store.patch({ overlay: { kind: 'none' } })
  }

  selectMode(mode: string): void {
    void this.applyMode(mode)
    this.closeModePicker()
  }

  // ── 主题（原型 31：改即存 + 实时预览——零保存按钮地狱）──

  openThemePicker(): void {
    this.store.patch({ overlay: { kind: 'theme' } })
  }

  closeThemePicker(): void {
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'theme') this.store.patch({ overlay: { kind: 'none' } })
  }

  /** 应用主题：色板即换（代理全局生效）+ settings.tuiTheme 持久化（重启保留） */
  selectTheme(name: string): void {
    const applied = setTuiTheme(name)
    this.store.patch({ themeName: applied })
    this.deps.setSetting?.('tuiTheme', applied)
    this.closeThemePicker()
    this.store.push({ kind: 'notice', text: `◆ 主题：${applied}` })
  }

  // ── 清屏（原型 50：/clear 会话保留）──

  clearScreen(): void {
    this.store.patch({ entries: [] })
    this.store.scrollToBottom() // 视图重建 → 贴底（顶锚定复位）
    this.store.push({ kind: 'notice', text: tuiT('tui.runtime.cleared') })
  }

  /** /new：新会话 + 转录视图同步清空（会话切换视图一致性——历史仍可 /sessions 与 Ctrl+↑↓ 召回） */
  async newSession(): Promise<void> {
    this.store.scrollToBottom()
    let out = ''
    try {
      const r = await this.deps.commandBus.execute('/new') as { output?: string }
      out = String(r?.output ?? '')
    } catch { /* 命令失败仍清视图（视图一致性优先） */ }
    this.store.patch({ entries: [] })
    this.sessionId = this.deps.sessionId?.() ?? this.sessionId // /new 切换会话——跟踪 id 同步（视图已清）
    this.refreshContext() // 新会话水位归零（usage_stats 按 session 聚合）
    this.store.push({ kind: 'notice', text: `◆ 新会话${out ? `：${out}` : ''}——转录视图已清空（/sessions 回历史 · Ctrl+↑↓ 召回）` })
  }

  // ── 二次确认（原型 46/59：敏感项确认——默认否防手滑，crush quit.go 同族）──

  /** 确认桥：resolve 'yes'/'no'（Esc=no）；危险样式橙色边框 */
  requestConfirm(message: string, opts: { danger?: boolean; yesLabel?: string; noLabel?: string } = {}): Promise<'yes' | 'no'> {
    return new Promise(resolve => {
      const pending: PendingConfirm = {
        id: this.store.id(),
        message,
        danger: opts.danger === true,
        choices: [
          { key: 'yes', label: opts.yesLabel ?? '确认' },
          { key: 'no', label: opts.noLabel ?? '否（默认）' },
        ],
        selected: 1, // 默认否——防手滑
        resolve: key => { this.store.patch({ overlay: { kind: 'none' } }); resolve(key === 'yes' ? 'yes' : 'no') },
      }
      this.store.patch({ overlay: { kind: 'confirm', pending } })
    })
  }

  // ── 配置面板（原型 59：三种值控件 × 改即存——零保存按钮地狱）──

  /** settings 实时快照（面板渲染与回读共用——与 kernel 共享同一 Config 对象） */
  configSnapshot(): Record<string, any> {
    return (this.deps.config.get('settings') ?? {}) as Record<string, any>
  }

  openConfigPanel(): void {
    this.store.patch({ overlay: { kind: 'config' } })
  }

  closeConfigPanel(): void {
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'config') this.store.patch({ overlay: { kind: 'none' } })
  }

  // ── 快捷键速查（原型 30：键位表单一事实来源——面板从 KEYS 生成）──

  openKeysPanel(): void {
    this.store.patch({ overlay: { kind: 'keys' } })
  }

  closeKeysPanel(): void {
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'keys') this.store.patch({ overlay: { kind: 'none' } })
  }

  // ── 回滚时间线（原型 28：user 消息时间线 + 影响统计 + 二次确认 → /undo N 命令面）──

  openRewindPanel(): void {
    this.store.patch({ overlay: { kind: 'rewind' } })
  }

  closeRewindPanel(): void {
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'rewind') this.store.patch({ overlay: { kind: 'none' } })
  }

  sessionMessages(): Array<{ runNo: number; ts: number; preview: string }> {
    return this.deps.sessionMessages?.() ?? []
  }

  /** 确认回滚（原型 28 影响统计先行）→ /undo N（内核软归档回滚：消息入历史存档 + 自动快照可 restore） */
  requestUndo(n: number, impact: { messages: number }): void {
    this.closeRewindPanel()
    void this.requestConfirm(
      `回滚最近 ${n} 轮：将归档其后约 ${impact.messages} 条消息（历史存档仍可检索 · 回滚前自动快照可 /checkpoint restore）`,
      { danger: true, yesLabel: `回滚 ${n} 轮`, noLabel: '取消' },
    ).then(choice => {
      if (choice === 'yes') void this.runCommand(`/undo ${n}`)
    })
  }

  // ── 语音对话（原型 34：录音 → 本地转写 → 入输入框确认后发送；自动播报仅结果摘要）──

  private voiceTick: NodeJS.Timeout | null = null
  /** 流式 token 合并缓冲（降噪规则 8：Live 限帧——50ms 合批 ≈ 20fps，杜绝逐 token 全量重渲染 O(n²)） */
  private streamBuf = ''
  private streamTimer: NodeJS.Timeout | null = null

  /** 冲刷流式缓冲（合并写入 transcript——一次 appendStream 一次重渲染） */
  flushStream(): void {
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null }
    if (this.streamBuf) {
      const t = this.streamBuf
      this.streamBuf = ''
      this.store.appendStream(t)
    }
  }

  /** 重试流重置：删除本回合失败尝试的半截输出（kernel reset 契约——agent.ts:1538 同语义） */
  private dropCurrentAttempt(): void {
    const entries = this.store.getSnapshot().entries
    let idx = entries.length - 1
    while (idx >= 0 && entries[idx]!.kind !== 'user') idx--
    if (idx >= 0 && idx < entries.length - 1) {
      this.store.patch({ entries: entries.slice(0, idx + 1) })
      this.store.push({ kind: 'notice', text: tuiT('tui.runtime.retryCleared') })
    }
  }

  /** /voice：开始录音（不可用诚实降级——设备/ffmpeg 缺失不假装） */
  async toggleVoiceRecording(): Promise<void> {
    const voice = this.deps.voice
    if (!voice) {
      this.store.push({ kind: 'notice', text: '语音通道未接入（headless/精简装配）——文本输入可用' })
      return
    }
    if (!voice.available()) {
      this.store.push({ kind: 'error', text: '语音不可用（未找到录音设备/ffmpeg 缺失）', errorHint: 'WXNODUS_VOICE_DEVICE 指定麦克风 · 安装 ffmpeg 后重试 · 文本输入不受影响' })
      return
    }
    const started = await voice.start()
    if (!started.ok) {
      this.store.push({ kind: 'error', text: `录音启动失败：${started.error ?? '未知'}`, errorHint: '检查麦克风权限与设备占用后 /voice 重试' })
      return
    }
    this.store.patch({ voice: { state: 'recording', seconds: 0 }, overlay: { kind: 'voice' } })
    this.voiceTick = setInterval(() => {
      const v = this.store.getSnapshot().voice
      if (v.state === 'recording') this.store.patch({ voice: { ...v, seconds: v.seconds + 1 } })
    }, 1000)
    this.timers.push(this.voiceTick)
  }

  /** 停止录音并转写 → 入输入框（用户确认后发送——转写不进模型上下文，零污染） */
  async stopVoiceAndTranscribe(): Promise<void> {
    const voice = this.deps.voice
    this.store.patch({ voice: { state: 'transcribing', seconds: this.store.getSnapshot().voice.seconds } })
    if (!voice) { this.closeVoice(); return }
    const r = await voice.stop()
    this.closeVoice()
    if (r.ok && r.text?.trim()) {
      this.store.setComposerValue(r.text!.trim())
      this.store.push({ kind: 'notice', text: `✓ 转写完成（${this.store.getSnapshot().voice.seconds}s 录音）——已入输入框，确认后 Enter 发送` })
    } else {
      this.store.push({ kind: 'error', text: `转写失败：${r.error ?? '未知'}`, errorHint: 'SAPI 兜底不可用可安装 whisper.cpp（WXNODUS_VOICE_BIN）· 或直接文本输入' })
    }
  }

  /** 取消录音（丢弃——零残留） */
  cancelVoice(): void {
    this.deps.voice?.cancel()
    this.closeVoice()
    this.store.push({ kind: 'notice', text: '录音已取消（零残留）——文本输入不受影响' })
  }

  closeVoice(): void {
    if (this.voiceTick) { clearInterval(this.voiceTick); this.voiceTick = null }
    this.store.patch({ voice: { state: 'off', seconds: 0 }, overlay: { kind: 'none' } })
  }

  /** 自动播报（原型 34 免打扰默认：仅 voiceAutoSpeak=true 时读结果摘要，不读代码；兼容历史字符串存储） */
  maybeSpeak(text: string): void {
    if (!text.trim()) return
    const settings = (this.deps.config.get('settings') ?? {}) as Record<string, any>
    const voiceOn = settings.voiceAutoSpeak === true || settings.voiceAutoSpeak === 'true'
    if (!voiceOn) return
    const summary = text.split('\n').filter(l => l.trim()).slice(0, 2).join(' ').slice(0, 200)
    this.deps.voice?.speak(summary)
  }

  /** 配置面板 voice 播报开关（原型 34 免打扰——默认关；布尔口径同上） */
  toggleVoiceSpeak(): void {
    const on = this.configSnapshot().voiceAutoSpeak === true
    this.deps.setSetting?.('voiceAutoSpeak', !on)
    this.store.push({ kind: 'notice', text: `◆ voice 播报 → ${!on ? 'on' : 'off'}（回合结束读结果摘要 · 不读代码 · 已持久化）` })
  }

  /** toggle 控件（原型 59）：thinking 翻转——改即存 + 即时反馈三件套（徽章/下回合/持久化）
   *  布尔口径：存布尔（非字符串）——e2e 真机测试捕获的「开关不可逆」缺陷修复 */
  toggleThinking(): void {
    const on = this.configSnapshot().thinking === true
    this.deps.setSetting?.('thinking', !on)
    this.store.push({ kind: 'notice', text: `◆ thinking → ${!on ? 'on' : 'off'}（下回合系统提示即变 · 已持久化）` })
  }

  /** 循环控件（原型 59）：语言 zh-CN↔en 即切（欢迎语/提示词同变） */
  toggleLang(): void {
    const lang = String(this.configSnapshot().lang ?? 'zh-CN')
    const next = lang === 'en' ? 'zh-CN' : 'en'
    this.deps.setSetting?.('lang', next)
    this.store.push({ kind: 'notice', text: tuiT('tui.runtime.langSwitched', { lang: next }) })
  }

  /** 数字控件（原型 59 · G9）：contextLimit 步进 8k（8k..256k）——改即存，下回合经 maxContextTokens 真实消费 */
  setContextLimit(value: number): void {
    const v = Math.min(262_144, Math.max(8_192, Math.round(value / 8_192) * 8_192))
    this.deps.setSetting?.('contextLimit', String(v))
    this.store.push({ kind: 'notice', text: `◆ contextLimit → ${v >= 1024 ? `${v / 1024}k` : v}（下回合生效 · 已持久化）` })
  }

  /** 端点探测透传（原型 58 测试连接——网络在 cli，TUI 零网络） */
  probeEndpoint(baseURL: string, apiKey: string): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    if (!this.deps.probeEndpoint) return Promise.resolve({ ok: false, error: '探测通道未接入（headless/精简装配）' })
    return this.deps.probeEndpoint(baseURL, apiKey)
  }

  // ── 压缩三选（原型 32 · G10：上下文超阈值——回合暂停征求；超时 30s 回退 auto 现行为）──

  // ── 计划提案（原型 06 · G1：批准/编辑/返回——批准前零副作用由内核零工具闸保证）──

  requestPlanApproval(text: string): Promise<'approve' | 'edit' | 'cancel'> {
    return new Promise(resolve => {
      const pending: PendingPlan = {
        id: this.store.id(),
        text,
        selected: 0,
        resolve: choice => { this.store.patch({ overlay: { kind: 'none' } }); resolve(choice) },
      }
      this.store.patch({ overlay: { kind: 'plan', pending } })
    })
  }

  requestPlanEdit(text: string): Promise<string | null> {
    return new Promise(resolve => {
      const pending: PendingPlanEdit = {
        id: this.store.id(),
        text,
        resolve: edited => { this.store.patch({ overlay: { kind: 'none' } }); resolve(edited) },
      }
      this.store.patch({ overlay: { kind: 'planedit', pending } })
    })
  }

  requestCompactChoice(info: { used: number; ctxLimit: number; compactAt: number }): Promise<'micro' | 'full' | 'none' | 'auto'> {
    return new Promise(resolve => {
      const ratio = info.ctxLimit > 0 ? Math.min(1, info.used / info.ctxLimit) : 0
      const pending: PendingCompact = {
        id: this.store.id(),
        used: info.used,
        limit: info.ctxLimit,
        ratio,
        choices: [
          { key: 'micro', label: 'micro 压缩（推荐）', desc: '裁剪旧工具结果 · 保留近轮完整 · 原文可展开' },
          { key: 'full', label: '全量压缩', desc: '旧轮整段归档为摘要 · 最省空间' },
          { key: 'none', label: '不压缩（继续）', desc: '413 超限时仍会强制压缩救场' },
        ],
        selected: 0,
        resolve: key => { this.store.patch({ overlay: { kind: 'none' } }); resolve(key) },
      }
      this.store.patch({ overlay: { kind: 'compact', pending } })
      // 超时回退 auto（现行为）——回合不悬挂
      const timeout = setTimeout(() => {
        if (this.store.getSnapshot().overlay.kind === 'compact') {
          this.store.push({ kind: 'notice', text: '压缩选择超时（30s）——按默认行为继续（micro + 全量）' })
          pending.resolve('auto')
        }
      }, 30_000)
      this.timers.push(timeout)
    })
  }

  // ── 自定义接口表单（原型 58 简版：三字段 → /model add 命令面——单一写路径）──

  openModelForm(): void {
    this.store.patch({ overlay: { kind: 'modelform' } })
  }

  closeModelForm(): void {
    const s = this.store.getSnapshot()
    if (s.overlay.kind === 'modelform') this.store.patch({ overlay: { kind: 'none' } })
  }

  /** 提交表单 → /model add <ID> --base <URL> --key <KEY>（https 校验/加密由 kernel addCustomModel 统一收口） */
  submitModelForm(fields: { name: string; baseURL: string; key: string }): void {
    const id = fields.name.trim().replace(/\s+/g, '-').slice(0, 40)
    if (!id) {
      this.store.push({ kind: 'error', text: '接口名称不能为空', errorHint: '名称即模型 ID（2-40 字符，空格转连字符）' })
      return
    }
    if (!/^https:\/\//.test(fields.baseURL.trim())) {
      this.store.push({ kind: 'error', text: 'Base URL 必须 https 开头（http 需 /perm 豁免）', errorHint: '例：https://api.example.com/v1' })
      return
    }
    this.closeModelForm()
    const keyPart = fields.key.trim() ? ` --key ${fields.key.trim()}` : ''
    void this.runCommand(`/model add ${id} --base ${fields.baseURL.trim()}${keyPart}`)
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
    store.scrollToBottom()
    store.push({ kind: 'user', text: prompt })
    store.beginTurn()
    store.sealStream() // 新回合：旧流式条目收口（防跨回合串流）
    this.goalStreamDone = false // 新回合复位（goal 末轮去重标记）
    this.ac = new AbortController()
    try {
      // G9：settings.contextLimit 真实消费——kernel opts.maxContextTokens 覆盖（未知模型/非法值零传递）
      const settings = (this.deps.config.get('settings') ?? {}) as Record<string, any>
      const ctxLimit = Number(settings.contextLimit)
      const ctxOpts = Number.isFinite(ctxLimit) && ctxLimit >= 4096 ? { maxContextTokens: Math.round(ctxLimit) } : {}
      // G10：压缩三选桥——上下文超阈值时暂停回合征求（桥缺失/异常/超时 → auto 现行为）
      const compactOpts = { onCompactChoice: (info: { used: number; ctxLimit: number; compactAt: number }) => this.requestCompactChoice(info) }
      // 原型 06：plan 模式回合 = 提案回合（内核零工具闸保证批准前零副作用）
      const wasPlan = this.store.getSnapshot().mode === 'plan'
      const r = await this.deps.agent.run(prompt, { signal: this.ac.signal, ...ctxOpts, ...compactOpts })
      // ⅩⅩⅧ（真机取证）：先冲刷 50ms 流式缓冲再判定「是否需要补推全文」——此前缓冲未落条目时
      // 守卫误判 last≠assistant 推 copy1，随后定时器 flush 又落 copy2 = 回合结果双条目重复。
      this.flushStream()
      if (r.text && store.getSnapshot().entries[store.getSnapshot().entries.length - 1]?.kind !== 'assistant' && !this.goalStreamDone) {
        store.push({ kind: 'assistant', text: r.text })
      }
      if (!r.ok) store.push({ kind: 'error', text: r.text || '回合未成功' })
      // 原型 34 自动播报（默认关——仅 settings.voiceAutoSpeak=true 读结果摘要）
      this.maybeSpeak(r.text)
      // 计划提案批准（原型 06：批准/编辑/返回——批准前零副作用；批准 = 切 smart 以计划为上下文执行）
      if (wasPlan && r.ok && r.text) {
        const choice = await this.requestPlanApproval(r.text.slice(0, 400))
        if (choice === 'approve') {
          this.store.push({ kind: 'notice', text: '◆ 已批准计划——切回 smart 执行' })
          await this.applyMode('smart')
          void this.send('按上述计划开始执行（已批准）')
        } else if (choice === 'edit') {
          const edited = await this.requestPlanEdit(r.text.slice(0, 400))
          if (edited?.trim()) {
            this.store.push({ kind: 'notice', text: '◆ 按修改后的计划执行' })
            await this.applyMode('smart')
            void this.send(edited.trim())
          }
        } else {
          this.store.push({ kind: 'notice', text: '计划保留（未执行）· /perm smart 后重发原话即可执行' })
        }
      }
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 200)
      const { hint } = classifyError(message)
      store.push({ kind: 'error', text: message, errorHint: hint })
    } finally {
      this.ac = null
      this.flushStream() // 回合收尾：冲刷残余流式缓冲（最后一块落屏）
      store.endTurn()
      this.refreshContext() // 回合结束水位收口（原型 26：用量常驻更新）
      // 队列续发（endTurn 出队 pendingSend；Esc 暂留态挂起 2s 窗口——超时续发或再按清空）
      const next = store.pendingSend
      store.pendingSend = null
      if (next && !this.exiting) {
        if (this.clearedQueued) {
          this.clearedQueued = false // 竞态防护：第二按 Esc 在收尾前清空——丢弃已出队消息
          this.pausedNext = null
        } else if (this.queuePaused) {
          this.pausedNext = next
          this.resumeTimer = setTimeout(() => this.resumeQueue(), Math.max(0, this.pauseUntil - Date.now()))
          this.timers.push(this.resumeTimer)
        } else {
          this.store.push({ kind: 'notice', text: `→ 发送排队消息：${next.slice(0, 50)}` })
          void this.send(next)
        }
      }
    }
  }

  private async runCommand(cmd: string): Promise<void> {
    const store = this.store
    store.scrollToBottom()
    store.push({ kind: 'user', text: cmd })
    // 命令执行心跳（长命令如 /build 数分钟——转录区一行「◈ 执行 …」，不再是一片死寂）
    store.patch({ command: { text: cmd, ms: 0 } })
    this.cmdAc = new AbortController()
    try {
      const out = await this.deps.commandBus.execute(cmd, { signal: this.cmdAc.signal })
      const r = out as { ok?: boolean; output?: string; error?: unknown; dispatch?: { kind?: string; name?: string; message?: string }; completionStatus?: string } | string
      const text = typeof r === 'string' ? r : String(r?.output ?? r?.error ?? '')
      const failed = typeof r === 'object' && r !== null && r.ok === false
      const cancelled = typeof r === 'object' && r !== null && r.completionStatus === 'cancelled'
      // 技能注入（/skill:name——kimi 风格：正文注入为消息发送；CLI 打印兜底，TUI 走发送链路——不再静默丢弃）
      if (typeof r === 'object' && r !== null && r.dispatch?.kind === 'skill' && typeof r.dispatch.message === 'string' && r.dispatch.message) {
        store.push({ kind: 'notice', text: `◆ 技能注入：${r.dispatch.name ?? 'skill'}——正文作为消息发送` })
        void this.send(r.dispatch.message)
      } else if (cancelled) {
        this.sessionId = this.deps.sessionId?.() ?? this.sessionId
        store.push({ kind: 'notice', text: text || '命令已取消' })
      } else {
        // 会话切换视图一致性：/resume（及任何切换 agent 会话的命令）→ 视图重建为当前会话
        const sidAfter = this.deps.sessionId?.() ?? null
        if (sidAfter !== null && sidAfter !== this.sessionId) {
          this.sessionId = sidAfter
          this.rehydrateSessionView(cmd, text)
        } else {
          this.sessionId = sidAfter ?? this.sessionId
          // /undo N 视图一致性：转录同步删除被回滚的用户轮次（内核软归档后屏幕不再展示）
          const undo = cmd.trim().match(/^\/undo\s+(\d+)$/)
          if (undo) this.trimTranscript(parseInt(undo[1]!, 10), cmd)
          // /checkpoint restore 视图一致性：同会话消息被快照替换 → 视图重建为恢复后的转录（失败不重建）
          const ckRestore = /^\/checkpoint\s+restore\b/.test(cmd.trim())
          if (ckRestore && !failed) this.rehydrateSessionView(cmd, text)
          else if (text) {
            // 失败命令按错误呈现（出路提示同行）——此前 ok:false 被当普通输出渲染（绿色助手行）
            if (failed) {
              const { hint } = classifyError(text)
              store.push({ kind: 'error', text, errorHint: hint })
            } else {
              store.push({ kind: 'assistant', text })
            }
          }
        }
      }
      const settings = (this.deps.config.get('settings') ?? {}) as Record<string, any>
      store.patch({ mode: String(settings.mode ?? store.getSnapshot().mode), model: String(settings.model ?? store.getSnapshot().model) })
      this.refreshContext() // 命令后水位收口（/compact /usage 等命令改变 usage_stats）
    } catch (e: any) {
      const message = `命令失败：${String(e?.message ?? e).slice(0, 160)}`
      const { hint } = classifyError(message)
      store.push({ kind: 'error', text: message, errorHint: hint })
    } finally {
      this.cmdAc = null
      store.patch({ command: null })
    }
  }

  /** 会话切换后视图重建：命令回显 + 新会话最近转录 + 同步通知（命令输出并入通知——零噪音） */
  private rehydrateSessionView(cmd: string, outputText: string): void {
    const entries: ChatEntry[] = [{ kind: 'user', text: cmd }]
    for (const m of (this.deps.sessionTranscript?.() ?? []).slice(-40)) {
      const text = String(m.text ?? '').trimEnd().slice(0, 3000)
      if (!text) continue
      entries.push({ kind: m.role === 'user' ? 'user' : 'assistant', text })
    }
    this.store.patch({ entries })
    this.store.scrollToBottom() // 视图重建 → 贴底（顶锚定复位）
    this.store.push({
      kind: 'notice',
      text: `◆ 视图已同步：会话 ${this.sessionId.slice(0, 8)}（${entries.length - 1} 条历史已加载）${outputText ? '——' + outputText : ''} · 直接输入继续对话`,
    })
  }

  /** /undo N 视图回退：删除最后 N 个用户轮次起的转录（命令回显行不计入轮次且常驻） */
  private trimTranscript(n: number, cmd: string): void {
    const entries = this.store.getSnapshot().entries
    const userIdx: number[] = []
    entries.forEach((e, i) => { if (e.kind === 'user' && e.text !== cmd) userIdx.push(i) })
    const dropFrom = userIdx.length > n ? userIdx[userIdx.length - n]! : 0
    const kept = entries.slice(0, Math.max(0, dropFrom))
    if (kept[kept.length - 1]?.kind !== 'user' || kept[kept.length - 1]?.text !== cmd) {
      kept.push({ kind: 'user', text: cmd }) // 命令回显常驻（即使整屏清空）
    }
    this.store.patch({ entries: kept })
    this.store.scrollToBottom() // 视图收缩 → 贴底（顶锚定复位）
  }

  /** Esc：运行中=中断（有队列则暂留 2s 窗口——再按清空，否则自动续发）；输入框=清空；帮助=关闭（退出保护三层——原型 30） */
  esc(): boolean {
    const s = this.store.getSnapshot()
    if (s.overlay.kind !== 'none' && s.overlay.kind !== 'help') return false // 浮层组件自处理
    if (s.overlay.kind === 'help') { this.store.patch({ overlay: { kind: 'none' } }); return true }
    // 第二按（暂留窗口内，无论是否已收尾）：清空队列——中断链条真正停住
    if (this.queuePaused && Date.now() < this.pauseUntil) {
      this.queuePaused = false
      this.clearedQueued = true
      const n = s.queue.length + (this.pausedNext ? 1 : 0) // 已出队暂留的也算
      this.pausedNext = null
      if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = null }
      this.store.patch({ queue: [] })
      this.store.push({ kind: 'notice', text: `已清空 ${n} 条排队消息（队列不再续发——重发请 Ctrl+↑ 召回原话）` })
      return true
    }
    if (s.running) {
      this.ac?.abort()
      this.deps.agent.abort()
      const queued = s.queue.length
      if (queued > 0) {
        this.queuePaused = true
        this.pauseUntil = Date.now() + 2000
        this.store.push({ kind: 'notice', text: `|| 已中断当前回合——${queued} 条排队消息暂留（2 秒内再按 Esc 清空队列，否则自动续发）` })
      } else {
        this.store.push({ kind: 'notice', text: '|| 已中断当前回合（会话保留）' })
      }
      return true
    }
    // 命令等待中断（长命令 /build 等——Esc 即回，不再死等；后台继续执行，进度仍回显）
    if (s.command) {
      this.cmdAc?.abort()
      this.store.push({ kind: 'notice', text: '|| 已中断命令等待（命令在后台继续执行——进度仍会回显）' })
      return true
    }
    // 空闲态：清空输入框（keys 面板承诺「Esc 清空输入」——零承诺漂移）
    if (s.composer.value) {
      this.store.setComposerValue('')
      this.store.setComposerSel(0)
      return true
    }
    return false
  }

  /** 暂留窗口超时：队列自动续发（Esc 中断不丢的既有承诺保持——只是多了可清空的 2s 窗口） */
  private resumeQueue(): void {
    this.resumeTimer = null
    this.queuePaused = false
    const next = this.pausedNext
    this.pausedNext = null
    if (next && !this.exiting) {
      this.store.push({ kind: 'notice', text: `→ 续发排队消息：${next.slice(0, 50)}` })
      void this.send(next)
    }
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
        deadline: Date.now() + (this.deps.approvalTimeoutMs ?? 300_000), // 倒计时（原型 05）
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
    if (this.voiceTick) { clearInterval(this.voiceTick); this.voiceTick = null }
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = null }
    this.flushStream()
    this.ac?.abort()
    this.cmdAc?.abort()
    this.flushHistory()
  }
}
