// src/wxnodus-ui/wxGateway.ts — WxNodus UI ↔ 内核桥接（进程内 GatewayClient）
// 设计：保持 GatewayClient 公开接口（start/request/drain/kill/getLogTail/on/off），
//       但不再 spawn python 子进程——直接路由到 wxnodus 内核（bus/db/config/mem/agent/commandBus）
//       wxnodus agent 事件 → GatewayEvent（message.delta/tool.*/status.update 等）
// 参考：gateway 客户端接口契约（业界通用） + wxnodus kernel/events 事件流
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { EventBus } from '../kernel/events.js'
import type { CommandBus } from '../app/CommandBus.js'
import { MODEL_CATALOG, encryptKey } from '../kernel/providers.js'
import { COMMAND_CAT, COMMAND_DESC, SLASH } from '../commands/registry.js'
import type { GatewayEvent } from './gatewayTypes.js'
import { ZERO } from './domain/usage.js'
import type { SessionInfo } from './types.js'

const LOG_LIMIT = 200

export interface WxGatewayKernel {
  bus: EventBus
  db: any
  config: any
  mem: { append(sessionId: string, role: string, content: string, toolCallId?: string): void; recallHybrid?(q: string, o?: { limit?: number }): any[] }
  agent: {
    run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>
    abort(): void
    setMode(m: string): void
    getMode(): string
    setSessionId(id: string): void
  }
  commandBus: CommandBus
  dataDir: string
  cwd: string
  settings: { apiKeyEnc?: string | null; baseURL?: string; model?: string; mode?: string; theme?: string; thinking?: boolean }
  applyModel: (modelId: string, baseURL?: string) => void
  setMode: (m: string) => void
  setTheme: (t: string) => void
  setThinking: (on: boolean) => void
  requestExit: () => void
}

interface PendingApproval {
  resolve: (ok: boolean) => void
}

export class GatewayClient extends EventEmitter {
  private kernel: WxGatewayKernel
  private ready = false
  private subscribed = false
  private bufferedEvents: GatewayEvent[] = []
  private logs: string[] = []
  private pendingApproval: PendingApproval | null = null
  private sessionSeq = 0
  private unsubscribe: Array<() => void> = []
  private running = false
  private currentSessionId = 'default'
  private finalText = ''

  constructor(kernel: WxGatewayKernel) {
    super()
    this.setMaxListeners(0)
    this.kernel = kernel
  }

  private pushLog(line: string) {
    this.logs.push(line)
    if (this.logs.length > LOG_LIMIT) this.logs.shift()
  }

  private publish(ev: GatewayEvent) {
    if (ev.type === 'gateway.ready') {
      this.ready = true
    }

    if (this.subscribed) {
      return void this.emit('event', ev)
    }

    this.bufferedEvents.push(ev)
  }

  // 事件翻译：wxnodus agent 事件 → GatewayEvent
  private attachBus() {
    const map: Record<string, (p: any) => void> = {
      'agent.start': () => {
        this.running = true
        this.publish({ type: 'message.start' })
        this.publish({ type: 'status.update', payload: { kind: 'thinking', text: 'running…' } })
      },
      'agent.token': (p) => {
        const text = String(p?.text ?? '')
        if (text) this.publish({ type: 'message.delta', payload: { text } })
      },
      'agent.message': (p) => {
        const content = String(p?.content ?? '')
        if (content) {
          this.finalText = content
          this.publish({ type: 'message.delta', payload: { text: content } })
        }
      },
      'agent.tool': (p) => {
        const name = String(p?.name ?? 'tool')
        if (p?.phase === 'start') {
          this.publish({
            type: 'tool.start',
            payload: {
              tool_id: `t${Date.now()}`,
              name,
              context: String(p?.ctx ?? ''),
              args_text: p?.args ? JSON.stringify(p.args).slice(0, 400) : undefined,
            },
          })
        } else {
          this.publish({
            type: 'tool.complete',
            payload: {
              tool_id: `t${Date.now()}`,
              name,
              error: p?.ok ? undefined : String(p?.detail ?? 'failed'),
              summary: String(p?.detail ?? (p?.ok ? 'ok' : 'failed')),
              duration_s: Number(p?.ms ?? 0) / 1000,
            },
          })
        }
      },
      'agent.stage': (p) => {
        const stage = String(p?.stage ?? '')
        if (stage) this.publish({ type: 'status.update', payload: { kind: 'thinking', text: stage } })
      },
      'agent.error': (p) => {
        this.running = false
        this.publish({ type: 'error', payload: { message: String(p?.message ?? 'agent error') } })
      },
      'agent.end': (p) => {
        this.running = false
        this.publish({ type: 'message.complete', payload: { text: this.finalText } })
        this.finalText = ''
        this.publish({ type: 'status.update', payload: { kind: 'done', text: 'ready' } })
      },
      'system.notice': (p) => {
        this.publish({ type: 'notification.show', payload: { text: String(p?.text ?? ''), level: 'info' } })
      },
    }

    for (const [type, fn] of Object.entries(map)) {
      this.unsubscribe.push(this.kernel.bus.on(type, (e) => fn(e.payload)))
    }
  }

  start() {
    this.attachBus()
    this.currentSessionId = 'default'
    this.kernel.agent.setSessionId(this.currentSessionId)
    this.publish({ type: 'gateway.ready' })
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (method) {
      case 'command.dispatch': return this.dispatchCommand(params) as T
      case 'prompt.submit': return this.promptSubmit(params) as T
      case 'slash.exec': return this.slashExec(params) as T
      case 'session.create': return this.sessionCreate(params) as T
      case 'session.activate': return this.sessionActivate(params) as T
      case 'session.resume': return this.sessionResume(params) as T
      case 'session.close': return this.sessionClose(params) as T
      case 'session.active_list': return this.sessionActiveList(params) as T
      case 'session.most_recent': return this.sessionMostRecent() as T
      case 'session.title': return this.sessionTitle(params) as T
      case 'session.steer': return { status: 'rejected' } as T
      case 'session.interrupt': return this.sessionInterrupt() as T
      case 'config.get': return this.configGet(params) as T
      case 'config.set': return this.configSet(params) as T
      case 'setup.status': return this.setupStatus() as T
      case 'approval.respond': return this.approvalRespond(params) as T
      case 'clarify.respond': return this.clarifyRespond(params) as T
      case 'sudo.respond': return {} as T
      case 'secret.respond': return {} as T
      case 'clipboard.paste': return { attached: false, message: '未检测到剪贴板图片' } as T
      case 'terminal.resize': return {} as T
      case 'input.detect_drop': return this.detectDrop(params) as T
      case 'shell.exec': return this.shellExec(params) as T
      case 'commands.catalog': return this.commandsCatalog() as T
      case 'complete.slash': return this.completeSlash(params) as T
      case 'complete.path': return this.completePath(params) as T
      case 'model.options': return this.modelOptions(params) as T
      case 'model.save_key': return this.modelSaveKey(params) as T
      case 'delegation.status': return { active: [], max_concurrent_children: 4, max_spawn_depth: 3, paused: false } as T
      case 'spawn_tree.save': return {} as T
      case 'reload.mcp': return {} as T
      case 'voice.toggle': return { enabled: false } as T
      case 'voice.record': return { ok: false, message: '语音不可用' } as T
      case 'image.attach': return {} as T
      default:
        this.pushLog(`[rpc] unsupported method: ${method}`)
        throw new Error(`unsupported rpc: ${method}`)
    }
  }

  // ── RPC 服务面 ─────────────────────────────────────────────

  private async dispatchCommand(params: Record<string, unknown>): Promise<unknown> {
    const arg = String(params.arg ?? '')
    const name = String(params.name ?? '')
    const input = `/${name}${arg ? ` ${arg}` : ''}`
    const r = await this.kernel.commandBus.execute(input)

    return { type: 'exec', output: r.output ?? r.error ?? '' }
  }

  private async promptSubmit(params: Record<string, unknown>): Promise<unknown> {
    const text = String(params.text ?? '').trim()

    if (!text) return { ok: true }

    if (this.running) {
      throw new Error('session busy: waiting for model response')
    }

    // 后台执行 agent（事件流驱动 UI），不阻塞 RPC
    void this.kernel.agent.run(text).catch((e) => {
      process.stderr.write(`[wxGateway] agent.run failed: ${e?.message ?? e}\n`)
      this.running = false
      this.publish({ type: 'error', payload: { message: String(e?.message ?? 'agent run failed') } })
    })

    return { ok: true }
  }

  private async slashExec(params: Record<string, unknown>): Promise<unknown> {
    const command = String(params.command ?? '').trim()
    const r = await this.kernel.commandBus.execute(`/${command}`)

    return { output: r.output ?? '', warning: r.error }
  }

  private async sessionCreate(params: Record<string, unknown>): Promise<unknown> {
    const cols = Number(params.cols ?? 80)
    const id = `s${Date.now()}${++this.sessionSeq}`
    const now = Date.now()

    try {
      this.kernel.db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`).run(id, '', now, now)
    } catch {
      // 内存模式降级
    }

    this.currentSessionId = id
    this.kernel.agent.setSessionId(id)

    return { session_id: id, info: this.buildInfo() }
  }

  private async sessionActivate(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? '')
    const messages = this.loadMessages(id)

    this.currentSessionId = id
    this.kernel.agent.setSessionId(id)

    return { session_id: id, messages, info: this.buildInfo(), running: false, started_at: Date.now() / 1000 }
  }

  private async sessionResume(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? '')
    const messages = this.loadMessages(id)

    this.currentSessionId = id
    this.kernel.agent.setSessionId(id)

    return {
      session_id: id,
      resumed: id,
      messages,
      info: this.buildInfo(),
      running: false,
      started_at: Date.now() / 1000,
    }
  }

  private async sessionClose(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? '')

    try {
      this.kernel.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), id)
    } catch {
      // 忽略
    }

    return { ok: true }
  }

  private async sessionActiveList(params: Record<string, unknown>): Promise<unknown> {
    const current = String(params.current_session_id ?? '')
    let rows: any[] = []

    try {
      rows = this.kernel.db.prepare(
        `SELECT s.id, s.title, s.created_at AS started_at, s.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s ORDER BY s.updated_at DESC LIMIT 20`
      ).all()
    } catch {
      rows = []
    }

    const sessions = rows.map((r: any) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      current: String(r.id) === current,
      started_at: Number(r.started_at ?? 0) / 1000,
      message_count: Number(r.message_count ?? 0),
      model: this.kernel.settings.model ?? '',
      status: 'idle' as const,
    }))

    return { sessions }
  }

  private async sessionMostRecent(): Promise<unknown> {
    let row: any = null

    try {
      row = this.kernel.db.prepare(`SELECT id, title, created_at FROM sessions ORDER BY updated_at DESC LIMIT 1`).get()
    } catch {
      row = null
    }

    if (!row) return { session_id: null }

    return {
      session_id: String(row.id),
      title: String(row.title ?? ''),
      started_at: Number(row.created_at ?? 0) / 1000,
    }
  }

  private async sessionTitle(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? '')
    const title = String(params.title ?? '')

    try {
      this.kernel.db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id)
    } catch {
      // 忽略
    }

    return { title }
  }

  private async sessionInterrupt(): Promise<unknown> {
    this.kernel.agent.abort()
    this.running = false

    return { ok: true }
  }

  private configGet(params: Record<string, unknown>): unknown {
    const key = String(params.key ?? '')

    if (key === 'mtime') {
      return { mtime: 0 }
    }

    const s = this.kernel.settings

    return {
      config: {
        display: {
          bell_on_complete: false,
          busy_input_mode: 'queue',
          details_mode: 'collapsed',
          inline_diffs: true,
          mouse_tracking: 'all',
          show_cost: false,
          show_reasoning: Boolean(s.thinking),
          streaming: true,
          tui_compact: false,
          tui_status_indicator: 'kaomoji',
          tui_statusbar: 'bottom',
        },
        paste_collapse_threshold: 5,
        paste_collapse_char_threshold: 2000,
      },
    }
  }

  private configSet(params: Record<string, unknown>): unknown {
    const key = String(params.key ?? '')
    const value = String(params.value ?? '')
    const s = this.kernel.settings

    if (key === 'model') {
      this.kernel.applyModel(value)
    } else if (key === 'mode') {
      this.kernel.setMode(value)
      this.kernel.agent.setMode(value)
    } else if (key === 'theme') {
      this.kernel.setTheme(value)
    } else if (key === 'thinking') {
      this.kernel.setThinking(value === 'true' || value === 'on' || value === '1')
    }

    return { value: s[key as keyof typeof s] ?? value }
  }

  private setupStatus(): unknown {
    const s = this.kernel.settings
    // wxnodus 哲学：无 key 时规则脑兜底（诚实回答 + /key 提示），无需强制配置——
    // 始终放行，避免 Setup Required 门禁阻塞本地可用的规则脑模式
    const configured = Boolean(s.apiKeyEnc)

    if (configured) {
      const fallback = MODEL_CATALOG.find((m) => m.modelId === (s.model ?? 'deepseek-v4-flash')) ?? MODEL_CATALOG[2]
      // model 缺失或非法（遗留命令串）→ 回退默认 modelId
      if (!s.model || !MODEL_CATALOG.some((m) => m.modelId === s.model)) s.model = fallback.modelId
      if (!s.baseURL) s.baseURL = fallback.baseURL
    }

    return { provider_configured: true }
  }

  private approvalRespond(params: Record<string, unknown>): unknown {
    const choice = String(params.choice ?? 'deny')

    if (this.pendingApproval) {
      this.pendingApproval.resolve(choice !== 'deny')
      this.pendingApproval = null
    }

    return { ok: true }
  }

  private clarifyRespond(params: Record<string, unknown>): unknown {
    const answer = String(params.answer ?? '')

    if (this.pendingApproval) {
      this.pendingApproval.resolve(answer !== '')
      this.pendingApproval = null
    }

    return { ok: true }
  }

  private detectDrop(params: Record<string, unknown>): unknown {
    const text = String(params.text ?? '').trim()
    const candidate = text.split(/\s+/)[0] ?? ''

    if (candidate && existsSync(candidate)) {
      return { matched: true, name: candidate, text }
    }

    return { matched: false }
  }

  private async shellExec(params: Record<string, unknown>): Promise<unknown> {
    const command = String(params.command ?? '')
    const cwd = this.kernel.cwd

    return new Promise((resolvePromise) => {
      execFile('cmd.exe', ['/c', command], { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
        resolvePromise({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: err ? (err as any).code ?? 1 : 0,
        })
      })
    })
  }

  private commandsCatalog(): unknown {
    const categories = new Map<string, [string, string][]>()
    const canon: Record<string, string> = {}

    for (const cmd of SLASH) {
      const cat = COMMAND_CAT[cmd] ?? '◈'
      if (!categories.has(cat)) categories.set(cat, [])
      categories.get(cat)!.push([cmd, COMMAND_DESC[cmd] ?? ''])
    }

    return {
      canon,
      categories: [...categories.entries()].map(([name, pairs]) => ({ name, pairs })),
      pairs: SLASH.map((cmd) => [cmd, COMMAND_DESC[cmd] ?? ''] as [string, string]),
      skill_count: 0,
      sub: {},
    }
  }

  private completeSlash(params: Record<string, unknown>): unknown {
    const text = String(params.text ?? '')
    const q = text.startsWith('/') ? text.slice(1).toLowerCase() : text.toLowerCase()
    const items = SLASH.filter((c) => c.slice(1).toLowerCase().startsWith(q)).slice(0, 12)
    const desc = (c: string) => COMMAND_DESC[c] ?? ''

    return {
      items: items.map((c) => ({ display: c, meta: desc(c), text: c })),
      replace_from: 1,
    }
  }

  private completePath(params: Record<string, unknown>): unknown {
    const word = String(params.word ?? '')
    const dir = word.includes('/') || word.includes('\\') ? word.slice(0, Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1) : ''
    const base = dir ? join(this.kernel.cwd, dir) : this.kernel.cwd
    const prefix = word.slice(dir.length).toLowerCase()
    let entries: string[] = []

    try {
      entries = (require('node:fs') as typeof import('node:fs')).readdirSync(base)
        .filter((n) => !n.startsWith('.') && n.toLowerCase().startsWith(prefix))
        .slice(0, 12)
    } catch {
      entries = []
    }

    return {
      items: entries.map((n) => ({ display: dir + n, text: dir + n })),
      replace_from: params.replaceFrom ?? 0,
    }
  }

  private modelOptions(params: Record<string, unknown>): unknown {
    const byProvider = new Map<string, any>()

    for (const m of MODEL_CATALOG) {
      if (!byProvider.has(m.provider)) {
        byProvider.set(m.provider, { name: m.name, slug: m.provider, models: [] })
      }
      byProvider.get(m.provider)!.models.push(m.modelId)
    }

    return {
      model: this.kernel.settings.model ?? '',
      providers: [...byProvider.values()].map((p) => ({
        ...p,
        models: [...new Set<string>(p.models)],
      })),
      session_id: params.session_id ?? null,
    }
  }

  private modelSaveKey(params: Record<string, unknown>): unknown {
    const key = String(params.key ?? '')
    const baseURL = String(params.base_url ?? '')

    if (key) {
      this.kernel.settings.apiKeyEnc = encryptKey(key)
      this.kernel.config.setKey('settings', 'apiKeyEnc', this.kernel.settings.apiKeyEnc)
      // 补默认模型/端点：有 key 但 model/baseURL 缺失时 agent 会降级规则脑
      // （提示「未配置」）——与 /key set 行为一致
      if (!this.kernel.config.getKey('settings', 'model')) this.kernel.config.setKey('settings', 'model', 'deepseek-v4-flash')
      if (!this.kernel.config.getKey('settings', 'baseURL')) this.kernel.config.setKey('settings', 'baseURL', 'https://api.deepseek.com/v1')
    }
    if (baseURL) {
      this.kernel.settings.baseURL = baseURL
      this.kernel.config.setKey('settings', 'baseURL', baseURL)
    }

    return {}
  }

  // ── 审批桥：agent 工具确认 → approval.request 事件 → approval.respond RPC ──
  requestApproval(name: string, args: Record<string, any>): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApproval = { resolve }
      this.publish({
        type: 'approval.request',
        payload: {
          command: name,
          description: args?.question ? String(args.question) : JSON.stringify(args ?? {}).slice(0, 300),
          allow_permanent: false,
        },
      })
    })
  }

  private loadMessages(sessionId: string): Array<{ role: 'assistant' | 'system' | 'tool' | 'user'; text: string }> {
    try {
      const rows = this.kernel.db.prepare(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY id`
      ).all(sessionId) as Array<{ role: string; content: string }>

      return rows
        .filter((r) => r.role === 'user' || r.role === 'assistant')
        .map((r) => ({ role: r.role as 'user' | 'assistant', text: r.content }))
    } catch {
      return []
    }
  }

  private buildInfo(): SessionInfo {
    const s = this.kernel.settings

    return {
      model: s.model ?? '',
      cwd: this.kernel.cwd,
      skills: {},
      tools: {},
      usage: { ...ZERO },
      version: '3.0.0',
    }
  }

  drain() {
    this.subscribed = true

    for (const ev of this.bufferedEvents) {
      this.emit('event', ev)
    }
    this.bufferedEvents = []
  }

  getLogTail(limit = 20): string {
    return this.logs.slice(-Math.max(1, limit)).join('\n')
  }

  kill(reason = 'requested') {
    this.pushLog(`[lifecycle] GatewayClient.kill reason=${reason}`)
    this.kernel.agent.abort()
    this.running = false
    for (const off of this.unsubscribe) {
      try { off() } catch { /* 忽略 */ }
    }
    this.unsubscribe = []
  }
}
