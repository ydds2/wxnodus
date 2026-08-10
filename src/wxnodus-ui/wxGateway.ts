// src/wxnodus-ui/wxGateway.ts — WxNodus UI ↔ 内核桥接（进程内 GatewayClient）
// 设计：保持 GatewayClient 公开接口（start/request/drain/kill/getLogTail/on/off），
//       但不再 spawn python 子进程——直接路由到 wxnodus 内核（bus/db/config/mem/agent/commandBus）
//       wxnodus agent 事件 → GatewayEvent（message.delta/tool.*/status.update 等）
// 参考：gateway 客户端接口契约（业界通用） + wxnodus kernel/events 事件流
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { EventBus } from '../kernel/events.js'
import type { CommandBus } from '../app/CommandBus.js'
import { MODEL_CATALOG, encryptKey } from '../kernel/providers.js'
import { classifyToolAction } from '../kernel/permissions.js'
import { COMMAND_CAT, COMMAND_DESC, SLASH } from '../commands/registry.js'
import type { GatewayEvent } from './gatewayTypes.js'
import { ZERO } from './domain/usage.js'
import type { SessionInfo } from './types.js'

const LOG_LIMIT = 200

export interface WxGatewayKernel {
  bus: EventBus
  db: any
  config: any
  mem: { append(sessionId: string, role: string, content: string, toolCallId?: string): void; recallHybrid?(q: string, o?: { limit?: number }): Promise<Array<{ id: number; content: string; score: number }>> }
  agent: {
    run(prompt: string): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>
    abort(): void
    setMode(m: string): void
    getMode(): string
    setSessionId(id: string): void
    steer(text: string): boolean
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
  resolve: (choice: string) => void
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
      'agent.subagent': (p) => {
        const phase = p?.phase === 'start' ? 'start' : 'complete'
        this.publish({
          type: phase === 'start' ? 'subagent.start' : 'subagent.complete',
          payload: { subagent_id: `sub-${Date.now().toString(36)}`, goal: String(p?.goal ?? ''), status: p?.ok ? 'completed' : 'error', task_index: 0 },
        })
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
      case 'session.undo': return this.sessionUndo(params) as T
      case 'session.delete': return this.sessionDelete(params) as T
      case 'session.fork': return this.sessionFork(params) as T
      case 'session.active_list': return this.sessionActiveList(params) as T
      case 'session.most_recent': return this.sessionMostRecent() as T
      case 'session.title': return this.sessionTitle(params) as T
      case 'session.steer': return this.sessionSteer(params) as T
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
      case 'model.disconnect': return this.modelDisconnect(params) as T
      case 'delegation.status': return { active: [], max_concurrent_children: 4, max_spawn_depth: 3, paused: false } as T
      case 'spawn_tree.save': return {} as T
      case 'skills.manage': return this.skillsManage(params) as T
      case 'skills.reload': return { output: '技能缓存已清空（发现目录即时扫描）' } as T
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

    if (r.dispatch) {
      return { type: 'skill', name: r.dispatch.name, message: r.dispatch.message }
    }
    return { type: 'exec', output: r.output ?? r.error ?? '' }
  }

  private async skillsManage(params: Record<string, unknown>): Promise<unknown> {
    const { discoverSkills, loadSkill, installSkill } = await import('../kernel/skills.js')
    const action = String(params.action ?? 'list')
    const arg = String(params.arg ?? '')
    const name = String(params.name ?? '')
    const all = discoverSkills(this.kernel.dataDir, this.kernel.cwd)

    switch (action) {
      case 'list': {
        const cats: Record<string, string[]> = {}
        for (const s of all) {
          const cat = s.source === 'project' ? '项目' : s.source === 'forge' ? '锻造' : '用户'
          ;(cats[cat] ??= []).push(s.name)
        }
        return { skills: cats }
      }
      case 'inspect': {
        const s = loadSkill(this.kernel.dataDir, this.kernel.cwd, name || arg)
        if (!s) return { info: undefined }
        return { info: { name: s.meta.name, category: s.meta.source, description: s.meta.description, path: s.meta.path } }
      }
      case 'search': {
        const q = arg.toLowerCase()
        const results = all.filter(s => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
          .map(s => ({ name: s.name, description: s.description }))
        return { results }
      }
      case 'install': {
        try {
          const dir = installSkill(this.kernel.dataDir, name || arg)
          return { installed: true, name: dir.split(/[\\/]/).pop() }
        } catch (e: any) {
          return { installed: false, name: String(e?.message ?? e) }
        }
      }
      case 'browse': {
        const items = all.map(s => ({ name: s.name, description: s.description, source: s.source }))
        return { items, page: 1, total: items.length, total_pages: 1 }
      }
      default:
        return { skills: {} }
    }
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

    if (r.dispatch) {
      return { type: 'skill', name: r.dispatch.name, message: r.dispatch.message }
    }
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

  // F2 修复：session.delete 真实实现（级联删消息/checkpoints；当前会话则重置）
  private async sessionDelete(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? this.currentSessionId)
    const exists = this.kernel.db.prepare(`SELECT id FROM sessions WHERE id=?`).get(id) as { id: string } | undefined
    if (!exists) return { ok: false, message: `会话不存在：${id}` }

    this.kernel.db.prepare(`DELETE FROM messages WHERE session_id=?`).run(id)
    this.kernel.db.prepare(`DELETE FROM checkpoints WHERE session_id=?`).run(id)
    this.kernel.db.prepare(`DELETE FROM sessions WHERE id=?`).run(id)

    if (this.currentSessionId === id) {
      this.currentSessionId = 'default'
      this.kernel.agent.setSessionId('default')
    }
    this.publish({ type: 'status.update', payload: { kind: 'done', text: 'ready' } })

    return { ok: true, deleted: id }
  }

  // F7 修复：session.steer 真实现（注入当前回合）
  private async sessionSteer(params: Record<string, unknown>): Promise<unknown> {
    const text = String(params.text ?? '').trim()
    if (!text) return { status: 'rejected', reason: 'empty steer text' }
    const ok = this.kernel.agent.steer(text)
    return ok ? { status: 'queued' } : { status: 'rejected', reason: 'agent not running' }
  }

  // session.undo：删除当前会话最后一条非 system 消息（真实实现，复活 UI 撤销/重试）
  // 对比轮 5 修复：running 守卫（hermes 4009 拒绝）——运行中撤销会造成 DB/内存分叉
  private async sessionUndo(params: Record<string, unknown>): Promise<unknown> {
    if (this.running) {
      return { ok: false, code: 4009, message: 'agent 运行中不能撤销——请先中断' }
    }
    const id = String(params.session_id ?? this.currentSessionId)
    const last = this.kernel.db.prepare(`SELECT id FROM messages WHERE session_id=? AND role!='system' ORDER BY id DESC LIMIT 1`).get(id) as { id: number } | undefined

    if (!last) {
      return { ok: false, message: '没有可撤销的消息' }
    }

    this.kernel.db.prepare(`DELETE FROM messages WHERE id=?`).run(last.id)
    this.publish({ type: 'status.update', payload: { kind: 'done', text: 'ready' } })

    return { ok: true, deleted_id: last.id }
  }

  // session.fork：复制会话（含全部消息）为分支并激活
  private async sessionFork(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? this.currentSessionId)
    const newId = `s${Date.now()}f${++this.sessionSeq}`
    const src = this.kernel.db.prepare(`SELECT title FROM sessions WHERE id=?`).get(id) as { title: string } | undefined

    if (!src) {
      return { ok: false, message: `会话不存在：${id}` }
    }

    const now = Date.now()
    this.kernel.db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(newId, `${src.title || id} (fork)`, now, now)
    this.kernel.db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_call_id, archived, ts)
      SELECT ?, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=?
    `).run(newId, id)

    this.currentSessionId = newId
    this.kernel.agent.setSessionId(newId)
    this.publish({ type: 'session.info', payload: this.buildInfo() })

    return { ok: true, session_id: newId, info: this.buildInfo() }
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
      // UI 模型选择器传入的是命令串（"modelId --provider slug [--global|--session]"）——
      // 解析出 modelId 再应用，避免把命令串整体写进 settings.model
      // （会导致 API 模型名非法 + 状态栏显示乱串）
      const modelId = value.split(/\s+/)[0] ?? value
      const slug = /--provider\s+(\S+)/.exec(value)?.[1]
      const hit = MODEL_CATALOG.find(m => m.modelId === modelId || m.provider === slug)
      this.kernel.applyModel(hit ? hit.modelId : modelId, hit?.baseURL)
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
      this.pendingApproval.resolve(choice)
      this.pendingApproval = null
    }

    return { ok: true }
  }

  private clarifyRespond(params: Record<string, unknown>): unknown {
    const answer = String(params.answer ?? '')

    if (this.pendingApproval) {
      this.pendingApproval.resolve(answer !== '' ? 'allow' : 'deny')
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
    // 32 条 ≈ 2-3 页（建议面板窗口 16 行 + PgUp/PgDn 翻页浏览全部命令）
    const items = SLASH.filter((c) => c.slice(1).toLowerCase().startsWith(q)).slice(0, 32)
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
      entries = readdirSync(base)
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
    // 有密钥即视为已认证（规则脑模式始终可用，无门禁）
    const authenticated = Boolean(this.kernel.settings.apiKeyEnc)

    for (const m of MODEL_CATALOG) {
      if (!byProvider.has(m.provider)) {
        byProvider.set(m.provider, {
          name: m.name,
          slug: m.provider,
          models: [],
          // modelPicker 依赖 authenticated/auth_type/key_env 决定是否进入
          // 密钥输入 stage——缺失时密钥保存链路永远无法触发
          authenticated,
          auth_type: 'api_key',
          key_env: `WXNODUS_${m.provider.toUpperCase()}_KEY`,
        })
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
    // 兼容双契约：picker 传 { slug, api_key }，旧调用传 { key, base_url }
    const key = String(params.api_key ?? params.key ?? '')
    const baseURL = String(params.base_url ?? params.baseURL ?? '')

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

    // picker 期待 { provider }（含 authenticated）——返回保存后的 provider
    const slug = String(params.slug ?? '')
    const byProvider = new Map<string, any>()

    for (const m of MODEL_CATALOG) {
      if (!byProvider.has(m.provider)) {
        byProvider.set(m.provider, {
          name: m.name,
          slug: m.provider,
          models: [],
          authenticated: Boolean(this.kernel.settings.apiKeyEnc),
          auth_type: 'api_key',
          key_env: `WXNODUS_${m.provider.toUpperCase()}_KEY`,
        })
      }
      byProvider.get(m.provider)!.models.push(m.modelId)
    }

    return {
      provider: byProvider.get(slug) ?? { slug, authenticated: Boolean(key), models: [] },
    }
  }

  private modelDisconnect(_params: Record<string, unknown>): unknown {
    // 断开连接：清除密钥（模型选择器 ^d + 确认）
    this.kernel.settings.apiKeyEnc = ''
    this.kernel.config.setKey('settings', 'apiKeyEnc', '')

    return { disconnected: true }
  }

  // ── 审批桥：agent 工具确认 → approval.request 事件 → approval.respond RPC ──
  // 返回用户选择：'allow'（一次）/ 'session'（本会话）/ 'deny'（拒绝）——Kimi auto_approve_actions 同款
  requestApproval(name: string, args: Record<string, any>): Promise<'allow' | 'session' | 'deny'> {
    return new Promise((resolve) => {
      this.pendingApproval = { resolve: (choice: string) => resolve(choice === 'deny' ? 'deny' : choice === 'session' ? 'session' : 'allow') }
      const cls = classifyToolAction(name, args)
      this.publish({
        type: 'approval.request',
        payload: {
          command: name,
          // bash 直接显示命令原文（而非 JSON 包裹）；其他工具显示参数 JSON
          description: args?.question ? String(args.question) : name === 'bash' ? String(args?.command ?? '') : JSON.stringify(args ?? {}).slice(0, 300),
          allow_permanent: false,
          tool: name,
          category: cls.label,
          icon: cls.icon,
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
