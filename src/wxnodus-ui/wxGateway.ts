// src/wxnodus-ui/wxGateway.ts — WxNodus UI ↔ 内核桥接（进程内 GatewayClient）
// 设计：保持 GatewayClient 公开接口（start/request/drain/kill/getLogTail/on/off），
//       但不再 spawn python 子进程——直接路由到 wxnodus 内核（bus/db/config/mem/agent/commandBus）
//       wxnodus agent 事件 → GatewayEvent（message.delta/tool.*/status.update 等）
// 参考：gateway 客户端接口契约（业界通用） + wxnodus kernel/events 事件流
import { EventEmitter } from 'node:events'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { join, resolve, basename, isAbsolute } from 'node:path'
import { attachmentsDir, clearPending, readPending, writePending } from '../kernel/imagePending.js'
import { WXNODUS_VERSION } from '../kernel/version.js'
import { knownSettingsKeys } from '../store/config.js'

import type { EventBus } from '../kernel/events.js'
import type { CommandBus } from '../app/CommandBus.js'
import { seedTurnTodos, syncToolTodo } from './lib/turnTodos.js'
import { MODEL_CATALOG } from '../kernel/providers.js'
import { priceForModel } from '../kernel/cost.js'
import { resolveDefaultModel } from '../kernel/defaults.js'
import { addCustomModel, applyModelKey, type ModelRegistryPort } from '../kernel/modelRegistry.js'
import { loadSkinFile } from '../kernel/skin.js'
import { checkVoice } from '../kernel/voice.js'
import { vadConfigFromSettings } from '../kernel/vad.js'
import { coreTools } from '../kernel/tools.js'
import { classifyToolAction } from '../kernel/permissions.js'
import { redactSecrets } from '../kernel/redact.js'
import { discoverSkills } from '../kernel/skills.js'
import { COMMAND_CAT, COMMAND_DESC, SLASH } from '../commands/registry.js'
import { PersonalizationService } from '../application/personalization/personalizationService.js'
import { ConfigRepository } from '../infrastructure/config/configRepository.js'
import { createPersonalizationRpcHandlers } from '../protocol/personalization.js'
import type { GatewayEvent } from './gatewayTypes.js'
import { ZERO } from './domain/usage.js'
import type { SessionInfo, TodoItem } from './types.js'

const LOG_LIMIT = 200

export interface WxGatewayKernel {
  bus: EventBus
  config: any
  /** W3 TUI facade：presentation adapter——db/agent/memory 原始句柄不再进入 UI 层（组合根持有） */
  adapter: import('../presentation/tui/tuiPresentationAdapter.js').TuiPresentationAdapter
  commandBus: CommandBus
  dataDir: string
  cwd: string
  /** A24：后台活动数据源（/term 终端会话；/jobs 并行任务）——UI 后台面板读取 */
  term?: import('../kernel/term.js').TermManager
  taskRunner?: import('../kernel/taskRunner.js').TaskRunner
  settings: { apiKeyEnc?: string | null; baseURL?: string; model?: string; mode?: string; theme?: string; thinking?: boolean }
  applyModel: (modelId: string, baseURL?: string) => void
  setMode: (m: string) => void
  setTheme: (t: string) => void
  setThinking: (on: boolean) => void
  requestExit: () => void
  reloadMcp?: () => Promise<{ ok: boolean; count: number; message: string }>
  /** A24 第三类修复：MCP 服务器真实状态（连接/工具数/传输方式）——buildInfo 填充 mcp_servers */
  mcpStatus?: () => Array<{ connected: boolean; name: string; tools: number; transport: string }>
  /** A24 第三类修复：当前系统提示词（kernel buildSystemPrompt 真实构建）——buildInfo 填充 system_prompt */
  systemPrompt?: () => string | undefined
  /** A24 第三类修复：落后上游提交数（进程启动时 git rev-list 真实计算；无 git/无 upstream → null）——buildInfo 填充 update_behind */
  updateBehind?: number | null
  /** 审计回调（组合根注入 appendAudit——gateway 不直接访问 db；model.add/save_key 落审计） */
  audit?: (event: string, payload: Record<string, unknown>) => void
}

// ── P3 图片附加链路：附件目录 + 待注入图片（pending.json）持久化 ──
// 共享事实源：kernel/imagePending.ts（命令层 /capture --attach 与 UI 层共用同一契约）

interface PendingApproval {
  resolve: (choice: string) => void
}

interface PendingClarify {
  resolve: (answer: string) => void
}

export class GatewayClient extends EventEmitter {
  private kernel: WxGatewayKernel
  private subscribed = false
  private bufferedEvents: GatewayEvent[] = []
  private logs: string[] = []
  private pendingApproval: PendingApproval | null = null
  private pendingClarify: PendingClarify | null = null
  // delegation.status 数据源（活跃子代理集合，agent.subagent 事件驱动）
  private activeSubagents = new Set<string>()
  /** A25：活跃子代理详情（subagent_id → goal/status，subagent.start/complete 事件维护）——
   *  delegation.status active 真实结构（此前 gateway 发 string[] 与类型 object[] 错配） */
  private activeSubagentDetail = new Map<string, { goal: string; started_at: number; status: string }>()
  // A12：会话切换 timeline 事件（loadMessages 一次性注入）
  private lastSessionEvent: { sid: string; text: string } | null = null
  private sessionSeq = 0
  private unsubscribe: Array<() => void> = []
  private running = false
  private currentSessionId = 'default'
  private finalText = ''
  /** A25：/tools disable 禁用集（进程内真实状态——updateTools 热生效） */
  private toolDisableSet: Set<string> | null = null
  // ── 语音模式（本地 whisper：/voice on 后 Ctrl+B 推按对话）──
  private voiceEnabled = false
  private voiceTts = false
  private voiceRecordingSession: import('../kernel/voice.js').RecordingSession | null = null
  private voiceTranscribing = false
  // ── A22 实时任务清单（工具调用序列 → 可勾选清单）──
  // 合成逻辑在 lib/turnTodos.ts（纯函数，可单测）：复杂请求先给骨架，
  // 首个真实工具落地时骨架让位——骨架只是预判，真实工具序列才是诚实清单
  private turnTodos: TodoItem[] = []

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
    if (this.subscribed) {
      return void this.emit('event', ev)
    }

    this.bufferedEvents.push(ev)
  }

  // 事件翻译：wxnodus agent 事件 → GatewayEvent
  private attachBus() {
    const map: Record<string, (p: any) => void> = {
      'agent.start': (p) => {
        this.running = true
        // A22：复杂请求先给骨架清单（复杂度启发式），随 message.start 送 UI
        this.turnTodos = seedTurnTodos(p?.prompt)
        this.publish({ type: 'message.start', payload: { todos: this.turnTodos } })
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
          // C9 修复：token 已逐块经 agent.token→message.delta 推送——此处不再重推全文
          // （否则 turnController bufRef 翻倍，直播渲染尾部闪现重复文本）
          // TTS（/voice tts 开启时）：Windows SAPI 本地朗读最终回复（异步不阻断）
          if (this.voiceTts) {
            void import('../kernel/voice.js').then(({ speakTts }) => {
              try { speakTts(content) } catch { /* TTS 失败静默（语音输出是附加能力） */ }
            })
          }
        }
      },
      // C5 修复：思考分片实时转发（UI reasoning.delta 事件，thinking 面板实时可见）
      // A25：子代理思考分流（session_id 以 :sub 结尾 → subagent.thinking 富事件——
      // 此前子代理推理混入主面板或直接丢失，agentsOverlay 思考区恒空）
      'reasoning.delta': (p) => {
        const text = String(p?.text ?? '')
        if (!text) return
        const sid = String(p?.session_id ?? '')
        if (sid.endsWith(':sub')) {
          this.publish({
            type: 'subagent.thinking',
            payload: { subagent_id: sid, text, goal: '', task_index: 0 },
          })
          return
        }
        this.publish({ type: 'reasoning.delta', payload: { text } })
      },
      'agent.tool': (p) => {
        const name = String(p?.name ?? 'tool')
        // C3 修复：工具调用稳定 id（内核生成，start/complete 同 id——UI 工具卡正确闭合）
        const toolId = String(p?.toolId ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
        // A25：子代理工具分流（session_id 以 :sub 结尾 → subagent.tool 富事件——
        // agentsOverlay 工具/笔记区此前恒空）
        const sid = String(p?.session_id ?? '')
        if (sid.endsWith(':sub')) {
          if (p?.phase === 'start') {
            this.publish({
              type: 'subagent.tool',
              payload: {
                subagent_id: sid,
                tool_name: name,
                tool_preview: String(p?.args ? JSON.stringify(p.args).slice(0, 160) : ''),
                goal: '',
                task_index: 0,
              },
            })
          }
          return
        }
        // A22：实时任务清单同步（工具序列 → ✓/[>] 清单，随事件送 UI）
        this.turnTodos = syncToolTodo(this.turnTodos, name, toolId, p?.phase === 'start', p?.args, Boolean(p?.ok))
        if (p?.phase === 'start') {
          this.publish({
            type: 'tool.start',
            payload: {
              tool_id: toolId,
              name,
              context: String(p?.ctx ?? ''),
              args_text: p?.args ? JSON.stringify(p.args).slice(0, 400) : undefined,
              todos: this.turnTodos,
            },
          })
          // A20：免提播报——语音模式开启时说出当前执行的工具（1.5s 节流）
          this.speakToolStart(name)
        } else {
          this.publish({
            type: 'tool.complete',
            payload: {
              tool_id: toolId,
              name,
              error: p?.ok ? undefined : String(p?.detail ?? 'failed'),
              summary: String(p?.detail ?? (p?.ok ? 'ok' : 'failed')),
              duration_s: Number(p?.ms ?? 0) / 1000,
              todos: this.turnTodos,
            },
          })
        }
      },
      'agent.stage': (p) => {
        const stage = String(p?.stage ?? '')
        if (stage) this.publish({ type: 'status.update', payload: { kind: 'thinking', text: stage } })
      },
      // A24：goal 循环进度（内核 goal 模式 + CLI /goal 共用）——状态行「goal 第 N/M 轮」+
      // 后台面板「目标循环」区（eventAdapter 的 kind:'goal' 分支此前是死代码，今天激活）
      'agent.goal': (p) => {
        const round = Number(p?.round ?? 1)
        const maxRounds = Number(p?.maxRounds ?? 10)
        const done = Boolean(p?.done)
        const cancelled = Boolean(p?.cancelled)
        const text = String(p?.text ?? '').slice(0, 120)
        const label = done
          ? `✓ goal 完成（${round}/${maxRounds} 轮）`
          : cancelled
            ? `✕ goal 已取消（${round}/${maxRounds} 轮）`
            : `↻ goal 第 ${round}/${maxRounds} 轮`
        this.publish({ type: 'status.update', payload: { kind: 'goal', text: label } })
        this.publish({ type: 'background.goal', payload: { active: !done, round, maxRounds, done, cancelled, text } })
      },
      'agent.error': (p) => {
        this.running = false
        this.publish({ type: 'error', payload: { message: String(p?.message ?? 'agent error') } })
      },
      'agent.subagent': (p) => {
        const phase = p?.phase === 'start' ? 'start' : 'complete'
        // C4 修复：subagent_id 稳定（内核生成——/agents 面板 complete 事件可匹配闭合）
        const subagentId = String(p?.subagent_id ?? `sub-${Date.now().toString(36)}`)
        // delegation.status 数据源：维护活跃子代理列表
        if (phase === 'start') {
          this.activeSubagents.add(subagentId)
          this.activeSubagentDetail.set(subagentId, { goal: String(p?.goal ?? ''), started_at: Date.now(), status: 'running' })
        } else {
          this.activeSubagents.delete(subagentId)
          const d = this.activeSubagentDetail.get(subagentId)
          if (d) this.activeSubagentDetail.set(subagentId, { ...d, status: p?.ok ? 'completed' : 'error' })
        }
        this.publish({
          type: phase === 'start' ? 'subagent.start' : 'subagent.complete',
          // A25：complete 补真实字段（turns/summary——此前仅 status，面板完成
          // 态缺轮次与摘要信息）
          payload: {
            subagent_id: subagentId,
            goal: String(p?.goal ?? ''),
            status: p?.ok ? 'completed' : 'error',
            task_index: 0,
            ...(phase === 'complete'
              ? {
                  summary: String(p?.text ?? p?.output ?? '').slice(0, 400) || undefined,
                  api_calls: Number(p?.turns ?? 0) || undefined,
                }
              : {}),
          },
        })
      },
      'agent.end': () => {
        this.running = false
        // A22：骨架是预判不是工作——整回合无真实工具落地（纯文本回答）时
        // 骨架不归档（避免「未完成骨架」噪音）；message.complete 携带最终
        // 清单，turnState 侧在归档前应用
        if (this.turnTodos.length && this.turnTodos.every(t => t.id.startsWith('tpl-'))) {
          this.turnTodos = []
        }
        // 状态栏 $ 成本段即时刷新（此前要等下次 session.info——回合结束后成本数字陈旧）：
        // 会话 usage 实时重查（含 cost_usd——全部模型有定价才给），回合结算后 UI 立即可见
        let liveUsage: { calls: number; input: number; output: number; total: number; cost_usd?: number } | undefined
        try {
          const row = this.kernel.adapter.data.usage.get(this.currentSessionId)
          if (row) liveUsage = { calls: row.calls ?? 0, input: row.input ?? 0, output: row.output ?? 0, total: (row.input ?? 0) + (row.output ?? 0), ...(typeof row.cost_usd === 'number' ? { cost_usd: row.cost_usd } : {}) }
        } catch { /* 用量读取失败不阻断回合收尾 */ }
        this.publish({ type: 'message.complete', payload: { text: this.finalText, todos: this.turnTodos, ...(liveUsage ? { usage: liveUsage } : {}) } })
        this.finalText = ''
        this.turnTodos = []
        // A22 连续对话：语音模式开 + 非唤醒态 → 回答结束后自动 re-arm VAD
        // （唤醒态有独立监听闭环，两者同时采麦克风会冲突）
        if (this.voiceEnabled && !this.voiceWake) {
          this.voiceContinuousArmed = true
          this.scheduleVoiceRearm(900)
        }
        this.publish({ type: 'status.update', payload: { kind: 'done', text: 'ready' } })
      },
      'system.notice': (p) => {
        this.publish({ type: 'notification.show', payload: { text: String(p?.text ?? ''), level: 'info' } })
      },
      // 开放兼容：后端 /theme 命令（bus）→ UI theme.changed（此前仅存字符串无 UI 效果）
      'theme.changed': (p) => {
        this.publish({ type: 'theme.changed', payload: { name: String(p?.name ?? 'wxnodus') } })
      },
      // A24 第四类修复：kernel jobs.created/complete → UI 即时刷新（此前事件只落
      // taskRunner 表，UI 后台面板仅靠 5s 轮询——任务完成要等下一轮才可见）
      'jobs.created': () => {
        this.publishBackgroundJobs()
      },
      'jobs.complete': () => {
        this.publishBackgroundJobs()
      },
    }

    for (const [type, fn] of Object.entries(map)) {
      this.unsubscribe.push(this.kernel.bus.on(type, (e) => fn(e.payload)))
    }
  }

  start() {
    this.attachBus()
    this.currentSessionId = 'default'
    this.kernel.adapter.agent.setSessionId(this.currentSessionId)
    // 开放兼容：gateway.ready 携带已配置皮肤（此前 skin 管道空转——数据源接上）
    const skin = loadSkinFile(this.kernel.dataDir, (this.kernel.settings as any)?.skin)
    this.publish({ type: 'gateway.ready', ...(skin ? { payload: { skin } } : {}) })
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this._dispatch(method, params)
    } catch (e: any) {
      // P1-3 错误码体系：WxError 带 code，其余归 INTERNAL——客户端可区分处理
      const code = e?.code ?? 5001
      const out = { ok: false, code, message: String(e?.message ?? e).slice(0, 300) }
      this.publish({ type: 'error', payload: out })
      return out as T
    }
  }

  private async _dispatch<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
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
      case 'session.active_list': return this.sessionActiveList(params) as T
      case 'session.list': return this.sessionList(params) as T
      case 'session.tail': return this.sessionTail(params) as T
      case 'diff.view': return this.diffView(params) as T
      case 'diff.revert': return this.diffRevert(params) as T
      case 'diff.mark': return this.diffMark(params) as T
      case 'session.most_recent': return this.sessionMostRecent() as T
      case 'session.title': return this.sessionTitle(params) as T
      case 'session.steer': return this.sessionSteer(params) as T
      case 'session.interrupt': return this.sessionInterrupt() as T
      case 'session.compress': return this.sessionCompress(params) as T
      case 'session.branch': return this.sessionBranch(params) as T
      // A25 第四类修复：死 RPC 真实实现（/save /rollback 此前可达但必失败）
      case 'session.save': return this.sessionSave(params) as T
      case 'rollback.list': return this.rollbackList(params) as T
      case 'rollback.diff': return this.rollbackDiff(params) as T
      case 'rollback.restore': return this.rollbackRestore(params) as T
      case 'tools.configure': return this.toolsConfigure(params) as T
      case 'reload.env': return this.reloadEnv(params) as T
      case 'paste.collapse': return this.pasteCollapse(params) as T
      case 'prompt.background': return this.promptBackground(params) as T
      case 'process.stop': return this.processStop() as T
      case 'config.get': return this.configGet(params) as T
      case 'config.set': return this.configSet(params) as T
      case 'config.listSettings': return this.configListSettings() as T
      case 'config.setSetting': return this.configSetSetting(params) as T
      case 'setup.status': return this.setupStatus() as T
      // W2-02：个性化 profile（真实 ConfigRepository + PersonalizationService，非假成功）
      case 'personalization.get':
      case 'personalization.update':
      case 'personalization.setup':
      case 'personalization.export':
      case 'personalization.import':
      case 'config.getFull':
        return this.personalizationRpc(method, params) as T
      case 'approval.respond': return this.approvalRespond(params) as T
      case 'clarify.respond': return this.clarifyRespond(params) as T
      case 'sudo.respond': return this.sudoRespond(params) as T
      case 'secret.respond': return this.secretRespond(params) as T
      case 'credential.respond': return this.credentialRespond(params) as T
      case 'clipboard.paste': return this.clipboardPaste(params) as T
      case 'terminal.resize': return this.terminalResize(params) as T
      case 'input.detect_drop': return this.detectDrop(params) as T
      case 'shell.exec': return this.shellExec(params) as T
      case 'commands.catalog': return this.commandsCatalog() as T
      case 'complete.slash': return this.completeSlash(params) as T
      case 'complete.path': return this.completePath(params) as T
      case 'balance.status': return this.balanceStatus(params) as T
      case 'usage.range': return this.usageRange(params) as T
      case 'usage.range.set': return this.usageRangeSet(params) as T
      case 'model.options': return this.modelOptions(params) as T
      case 'model.save_key': return this.modelSaveKey(params) as T
      case 'model.disconnect': return this.modelDisconnect(params) as T
      case 'model.add': return this.modelAdd(params) as T
      case 'system.battery': return this.systemBattery() as T
      case 'delegation.status': return this.delegationStatus() as T
      case 'spawn_tree.save': return this.spawnTreeSave(params) as T
      case 'spawn_tree.list': return this.spawnTreeList(params) as T
      case 'spawn_tree.load': return this.spawnTreeLoad(params) as T
      case 'subagent.interrupt': return this.subagentInterrupt(params) as T
      case 'delegation.pause': return this.delegationPause(params) as T
      case 'skills.manage': return this.skillsManage(params) as T
      case 'skills.reload':
        // 审计修复：不再假成功文案——清空技能名缓存并真实重扫
        this.skillNamesCache = null
        try {
          const n = this.discoverSkillNames().length
          return { output: `技能目录已重扫：${n} 个可用（/skill list 查看）` } as T
        } catch {
          return { output: '技能目录重扫完成（0 个可用）' } as T
        }
      case 'plugins.manage': return this.pluginsManage(params) as T
      case 'reload.mcp': return this.reloadMcp(params) as T
      case 'voice.toggle': return this.voiceToggle(params) as T
      case 'voice.record': return this.voiceRecord(params) as T
      case 'image.attach': return this.imageAttach(params) as T
      // 截图即问：Ctrl+Shift+P 一键截图并登记为待注入图片（下次提问随 prompt 进入
      // 能力门管线——视觉模型 inject / 文本模型 GLM 先识别）
      case 'capture.attach': return this.captureAttach(params) as T
      // A24：后台活动（/term 终端 /jobs 任务 /cron 定时——后台面板轮询数据源）
      case 'background.status': return this.backgroundStatus() as T
      // A24：目录选择器（dir.list 浏览 / cwd.set 切换工作目录）
      case 'dir.list': return this.dirList(params) as T
      case 'cwd.set': return this.cwdSet(params) as T
      default:
        this.pushLog(`[rpc] unsupported method: ${method}`)
        throw new Error(`unsupported rpc: ${method}`)
    }
  }

  // A24 第四类修复：终端尺寸调整真实转发（此前空 stub——/term 面板拖动或窗口
  // 尺寸变化时 PTY 从不跟随，换行错乱）。CLI 窗口 resize 时同步所有运行中
  // 后台终端（/term attach 视图随之正确换行）；显式 id 时只调整该终端。
  // 注意：UI 侧传的是 session_id（会话 id，非终端 id）——按广播语义处理。
  private terminalResize(params: Record<string, unknown>): unknown {
    const id = String(params.id ?? '')
    const cols = Math.max(1, Math.floor(Number(params.cols) || 100))
    const rows = Math.max(1, Math.floor(Number(params.rows) || 30))

    if (!this.kernel.term) {
      return { ok: false, error: '终端服务未装配' }
    }

    try {
      const targets = id
        ? this.kernel.term.list().filter(t => t.id === id)
        : this.kernel.term.list().filter(t => t.status === 'running')
      let resized = 0

      for (const t of targets) {
        if (this.kernel.term.resize(t.id, cols, rows).ok) {
          resized++
        }
      }

      if (!resized && !targets.length) {
        return { ok: false, error: id ? `终端 ${id} 不存在或已退出（/term 查看列表）` : '无运行中的后台终端' }
      }

      return { ok: true, resized }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 120) }
    }
  }

  // ── A24 后台活动状态（终端/任务/定时——后台面板与摘要行数据源）────────
  private backgroundStatus(): unknown {
    let terms: Array<Record<string, unknown>> = []
    try {
      terms = (this.kernel.term?.list() ?? []).map(t => ({
        id: t.id,
        shell: t.shell,
        cwd: t.cwd,
        status: t.status,
        exitCode: t.exitCode,
        startedAt: t.startedAt,
      }))
    } catch { /* term 未装配/异常按空列表 */ }

    let jobs: Array<Record<string, unknown>> = []
    try {
      jobs = (this.kernel.taskRunner?.list({ limit: 12 }) ?? []).map(j => ({
        id: j.id,
        goal: String(j.goal ?? '').slice(0, 80),
        status: j.status,
        kind: j.kind,
        created_at: j.created_at,
        done_at: j.done_at,
        exit_code: j.exit_code,
      }))
    } catch { /* taskRunner 未装配/异常按空列表 */ }

    let cron: Array<Record<string, unknown>> = []
    try {
      cron = this.kernel.adapter.data.cron.list().map(c => ({ id: c.id, schedule: c.schedule, action: String(c.action ?? '').slice(0, 60), enabled: !!c.enabled, last_run: c.last_run }))
    } catch { /* cron 表未就绪按空列表 */ }

    return { terms, jobs, cron }
  }

  // A24 第四类修复：jobs 事件 → UI 即时任务快照（与 background.status 同源映射——
  // taskRunner.list 真实数据，任务创建/完成即刻推送，不等 5s 轮询）
  private publishBackgroundJobs(): void {
    try {
      const jobs = (this.kernel.taskRunner?.list({ limit: 12 }) ?? []).map(j => ({
        id: j.id,
        goal: String(j.goal ?? '').slice(0, 80),
        status: j.status,
        kind: j.kind,
        created_at: j.created_at,
        done_at: j.done_at,
        exit_code: j.exit_code,
      }))

      this.publish({ type: 'background.jobs', payload: jobs as never })
    } catch { /* 任务表异常不推送（轮询兜底） */ }
  }

  // ── A24 目录选择器：浏览目录 ────────────────────────────────────────
  private dirList(params: Record<string, unknown>): unknown {
    const target = String(params.path ?? this.kernel.cwd)
    const p = isAbsolute(target) ? target : resolve(this.kernel.cwd, target)

    try {
      const st = statSync(p)
      if (!st.isDirectory()) return { ok: false, error: '不是目录' }
      const entries = readdirSync(p)
        .map(name => {
          try {
            return { name, isDir: statSync(join(p, name)).isDirectory() }
          } catch {
            return null
          }
        })
        .filter((e): e is { isDir: boolean; name: string } => e !== null)
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
      return { ok: true, path: p, entries }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 120) }
    }
  }

  // ── A24 目录选择器：切换工作目录（运行时生效，重启不记忆）────────────
  private cwdSet(params: Record<string, unknown>): unknown {
    const target = String(params.path ?? '')
    const p = isAbsolute(target) ? target : resolve(this.kernel.cwd, target)

    try {
      const st = statSync(p)
      if (!st.isDirectory()) return { ok: false, error: '不是目录' }
      process.chdir(p)
      this.kernel.cwd = p
      // 工具 ctx.cwd 跟随（fs/bash/term/search 全部经 ctx.cwd 解析）；
      // dataDir 保持启动值——会话数据/记忆/项目不随目录迁移
      this.kernel.adapter.agent.setCwd?.(p)
      // 重发 session.info → 状态栏 cwd / git 分支自动刷新
      this.publish({ type: 'session.info', payload: this.buildInfo() })
      this.publish({ type: 'notification.show', payload: { text: `已切换工作目录：${p}`, level: 'success' } })
      return { ok: true, cwd: p }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 120) }
    }
  }

  // delegation.status 真实数据：活跃子代理（agent.subagent start/complete 事件驱动）
  // A24 第四类修复：paused 读内核真实状态（此前硬编码 false——/delegate pause 后
  // 状态条只见瞬时闪烁，下一次 status 轮询即被覆盖回 false）
  // A25：caps 读内核真实限制（taskRunner 并发上限 + agent 委派深度上限——
  // 此前并发硬编码 4，与真实默认 2 不符）
  private delegationStatus(): unknown {
    return {
      active: [...this.activeSubagents].map(id => {
        const d = this.activeSubagentDetail.get(id)
        return d ? { subagent_id: id, goal: d.goal, started_at: d.started_at, status: d.status } : { subagent_id: id }
      }),
      max_concurrent_children: this.kernel.taskRunner?.getMaxConcurrent?.() ?? 2,
      max_spawn_depth: this.kernel.adapter.agent.getMaxSpawnDepth?.() ?? 3,
      paused: this.kernel.adapter.agent.getDelegationPaused?.() ?? false,
    }
  }

  // A7：system.battery 真实读取（Windows WMI Win32_Battery；无电池/失败 → available:false）
  // 状态条电池指示的数据源（参考同款 system.battery RPC）
  private batteryCache: { ts: number; value: unknown } | null = null

  private systemBattery(): unknown {
    // 5s 缓存——UI 30s 轮询，WMI 查询 ~100ms，避免每 30s 重复 spawn
    if (this.batteryCache && Date.now() - this.batteryCache.ts < 5000) {
      return this.batteryCache.value
    }

    const fallback = { available: false, percent: null, plugged: null, category: 'dim' }

    if (process.platform !== 'win32') {
      // macOS/Linux 无内置读取通道（参考后端同样平台相关）——诚实返回不可用
      return fallback
    }

    try {
      const script =
        'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress'
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim()
      const j = JSON.parse(raw) as { EstimatedChargeRemaining?: number; BatteryStatus?: number }
      const percent = typeof j.EstimatedChargeRemaining === 'number' ? Math.round(j.EstimatedChargeRemaining) : null
      // BatteryStatus: 2 = AC 供电（充电中/已充满）
      const plugged = j.BatteryStatus === 2
      const category = percent === null ? 'dim' : plugged ? 'good' : percent <= 10 ? 'critical' : percent <= 20 ? 'bad' : percent <= 50 ? 'warn' : 'good'
      const value = { available: percent !== null, percent, plugged, category }
      this.batteryCache = { ts: Date.now(), value }
      return value
    } catch {
      return fallback
    }
  }

  // ── RPC 服务面 ─────────────────────────────────────────────

  private async dispatchCommand(params: Record<string, unknown>): Promise<unknown> {
    const arg = String(params.arg ?? '')
    const name = String(params.name ?? '')
    const input = `/${name}${arg ? ` ${arg}` : ''}`
    const r = await this.kernel.commandBus.execute(input)

    // 命令可能改设置（/perm 切模式、/usage range、/model add|set-key…）——发布 session.info
    // 让状态栏徽章/模型段等 UI 实时反映（buildInfo 内部带缓存，非高频路径）。
    try {
      this.publish({ type: 'session.info', payload: this.buildInfo() })
    } catch { /* 发布失败不影响命令结果 */ }

    if (r.dispatch) {
      return { type: 'skill', name: r.dispatch.name, message: r.dispatch.message }
    }
    return { type: 'exec', output: r.output ?? r.error ?? '' }
  }

  // P1c：plugins.manage RPC（激活 UI pluginsHub 面板——此前为死分支）
  //   list：插件列表（名称/版本/描述/启用/工具数）
  //   toggle：启停（修改 plugin.json + updateTools 热更新 agent 工具表）
  private async pluginsManage(params: Record<string, unknown>): Promise<unknown> {
    const { loadAllPlugins, pluginToolsToExtra, setPluginEnabled } = await import('../kernel/plugins.js')
    const action = String(params.action ?? 'list')
    const name = String(params.name ?? '')

    if (action === 'list') {
      const all = await loadAllPlugins(this.kernel.dataDir, this.kernel.cwd)
      return {
        plugins: all.map(p => ({
          name: p.manifest.name,
          version: p.manifest.version,
          description: p.manifest.description ?? '',
          // UI 期望 status 字段（'enabled' | 'not enabled'）；enabled 保留兼容
          status: p.manifest.enabled !== false ? 'enabled' : 'not enabled',
          enabled: p.manifest.enabled !== false,
          source: 'user',
        })),
      }
    }

    if (action === 'toggle') {
      const enable = Boolean(params.enable)
      const dir = join(this.kernel.dataDir, 'plugins', name)
      if (!existsSync(join(dir, 'plugin.json'))) return { plugin: null }
      const ok = setPluginEnabled(dir, enable)
      // 热更新 agent 工具表（不重启）
      if (ok && this.kernel.adapter.agent?.updateTools) {
        const all = await loadAllPlugins(this.kernel.dataDir, this.kernel.cwd)
        this.kernel.adapter.agent.updateTools(pluginToolsToExtra(all))
      }
      return { plugin: { name, enabled: enable } }
    }

    return { plugins: [] }
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
      const { WxError, WX_ERR } = await import('../kernel/errors.js')
      throw new WxError(WX_ERR.BUSY, 'session busy: waiting for model response')
    }

    // P3 图片附加链路：会话有待注入图片 → 全部透传 agent.run——能力门收敛在 agent 环内
    // （视觉模型直接注入 parts；文本模型经视觉通道先识别为文本注入，无 key 诚实丢弃，
    // 见 agent.ts「多模态注入」防御纵深——绝不把 image_url 发给纯文本模型触发 400）。
    const sid = String(params.session_id ?? this.currentSessionId)
    const pending = readPending(this.kernel.dataDir, sid)
    let images: Array<{ dataUrl: string; mime: string }> | undefined
    if (pending) {
      const b64 = readFileSync(pending.file).toString('base64')
      images = [{ dataUrl: `data:${pending.mime};base64,${b64}`, mime: pending.mime }]
      clearPending(this.kernel.dataDir, sid)
    }
    // @提及展开（Claude Code @mention 同款）：@path 存在的文件读入并追加内容块——
    // 不存在的原文保留 + 通知；二进制跳过；散文中 @人名（无路径字符）零触发。
    let finalText = text
    try {
      const { expandMentions } = await import('../kernel/mentions.js')
      const r = expandMentions(text, {
        cwd: this.kernel.cwd,
        readFile: p => {
          try { return readFileSync(p) } catch { return null }
        },
      })
      finalText = r.text
      if (r.mentions.length) {
        this.publish({ type: 'notification.show', payload: { kind: 'ttl', level: 'info', text: `已展开 ${r.mentions.length} 个文件提及${r.mentions.some(m => m.truncated) ? '（超长已截断）' : ''}` } })
      }
      if (r.missing.length) {
        this.publish({ type: 'notification.show', payload: { kind: 'ttl', level: 'warn', text: `提及文件不存在（原文保留）：${r.missing.slice(0, 5).join('、')}` } })
      }
      if (r.skipped.length) {
        this.publish({ type: 'notification.show', payload: { kind: 'ttl', level: 'warn', text: `提及文件为二进制已跳过：${r.skipped.slice(0, 5).join('、')}` } })
      }
    } catch { /* 展开失败按原文提交 */ }

    // 后台执行 agent（事件流驱动 UI），不阻塞 RPC
    void this.kernel.adapter.agent.run(finalText, images ? { images } : undefined).catch((e) => {
      process.stderr.write(`[wxGateway] agent.run failed: ${e?.message ?? e}\n`)
      this.running = false
      this.publish({ type: 'error', payload: { message: String(e?.message ?? 'agent run failed') } })
    })

    return { ok: true }
  }

  private async slashExec(params: Record<string, unknown>): Promise<unknown> {
    const command = String(params.command ?? '').trim()
    const full = `/${command}`
    // 风险确认（2026-08-19）：danger 级命令在 TUI 直输通道强制走审批桥
    // （与工具审批同面板、同脱敏）——用户交互通道的风险可见性；
    // -p 直输（用户亲手键入）与 AI 通道（agent.ts wx_cmd 分级裁决）不经过本桥。
    const { classifyCommand } = await import('../kernel/commandLevels.js')
    if (classifyCommand(full) === 'danger' && params.confirm !== true) {
      const choice = await this.requestApproval('wx_cmd', { command: full })
      if (choice === 'deny') return { output: '', warning: `危险命令已取消（未执行）：${command}` }
    }
    const r = await this.kernel.commandBus.execute(full)

    if (r.dispatch) {
      return { type: 'skill', name: r.dispatch.name, message: r.dispatch.message }
    }
    return { output: r.output ?? '', warning: r.error }
  }

  private async sessionCreate(_params: Record<string, unknown>): Promise<unknown> {
    const id = `s${Date.now()}${++this.sessionSeq}`

    // W3 Session：真实 session 生命周期——工件（能力/hook 快照 + sha256）先行；失败 fail-closed，不产生无工件会话
    const ensured = await this.kernel.adapter.data.sessions.ensure(id)
    if (!ensured.ok) return { ok: false, message: `会话工件生成失败：${ensured.code}` }

    try {
      this.kernel.adapter.data.sessions.create(id)
    } catch {
      // 内存模式降级
    }

    this.currentSessionId = id
    this.kernel.adapter.agent.setSessionId(id)

    return { session_id: id, info: this.buildInfo() }
  }

  private async sessionActivate(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? '')
    this.lastSessionEvent = { sid: id, text: `已切换到会话 ${id}` }

    // W3 Session：resume 走真实 session——工件 read-back 重算（篡改/缺失 fail-closed，不静默重建）
    const ensured = await this.kernel.adapter.data.sessions.ensure(id)
    if (!ensured.ok) return { ok: false, message: `会话工件校验失败：${ensured.code}` }

    const messages = this.loadMessages(id)

    this.currentSessionId = id
    this.kernel.adapter.agent.setSessionId(id)

    return { session_id: id, messages, info: this.buildInfo(), running: false, started_at: Date.now() / 1000 }
  }

  private async sessionResume(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? '')
    this.lastSessionEvent = { sid: id, text: `已恢复会话 ${id}` }

    // W3 Session：resume 走真实 session——与 session.activate 同一工件闸门
    const ensured = await this.kernel.adapter.data.sessions.ensure(id)
    if (!ensured.ok) return { ok: false, message: `会话工件校验失败：${ensured.code}` }

    const messages = this.loadMessages(id)

    this.currentSessionId = id
    this.kernel.adapter.agent.setSessionId(id)

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

    this.kernel.adapter.data.sessions.touch(id, Date.now())

    return { ok: true }
  }

  // F2 修复：session.delete 真实实现（级联删消息/checkpoints；当前会话则重置）
  private async sessionDelete(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.session_id ?? this.currentSessionId)
    if (!this.kernel.adapter.data.sessions.exists(id)) return { ok: false, message: `会话不存在：${id}` }

    this.kernel.adapter.data.sessions.delete(id)

    if (this.currentSessionId === id) {
      this.currentSessionId = 'default'
      this.kernel.adapter.agent.setSessionId('default')
    }
    this.publish({ type: 'status.update', payload: { kind: 'done', text: 'ready' } })

    return { ok: true, deleted: id }
  }

  // reload.mcp：MCP 服务器热重载（/reload-mcp）——确认门 → 后端重连 + 工具表热换
  private async reloadMcp(params: Record<string, unknown>): Promise<unknown> {
    const confirmed = params.confirm === true || params.always === true
    if (!confirmed) {
      return { status: 'confirm_required', message: '重载 MCP 会失效模型提示缓存——确认请用 /reload-mcp now' }
    }
    if (!this.kernel.reloadMcp) {
      return { status: 'reloaded', message: '当前环境无 MCP 配置（data/mcp.json 为空或不支持重载）' }
    }
    const r = await this.kernel.reloadMcp()
    return { status: r.ok ? 'reloaded' : 'error', message: r.message }
  }

  // spawn_tree 持久化（/replay list|load 磁盘档案）：data/spawns/*.json
  // save 写入快照文件；list 按会话过滤倒序返回；load 按路径读取回放
  private async spawnTreeSave(params: Record<string, unknown>): Promise<unknown> {
    try {
      const dir = join(this.kernel.dataDir, 'spawns')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `spawn-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`)
      writeFileSync(file, JSON.stringify(params, null, 2), 'utf8')
      return { ok: true, path: file }
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e).slice(0, 120) }
    }
  }

  private async spawnTreeList(params: Record<string, unknown>): Promise<unknown> {
    const limit = Number(params.limit ?? 30)
    const sessionId = String(params.session_id ?? 'default')
    try {
      const dir = join(this.kernel.dataDir, 'spawns')
      if (!existsSync(dir)) return { entries: [] }
      const entries = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
        try {
          const snap = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, any>
          return {
            finished_at: Number(snap.finished_at ?? 0),
            label: String(snap.label ?? ''),
            count: Array.isArray(snap.subagents) ? snap.subagents.length : 0,
            path: join(dir, f),
            session_id: String(snap.session_id ?? ''),
          }
        } catch { return null }
      }).filter(Boolean)
        .filter((e: any) => e.session_id === sessionId)
        .sort((a: any, b: any) => b.finished_at - a.finished_at)
        .slice(0, Math.max(1, limit))
      return { entries }
    } catch (e: any) {
      return { entries: [], message: String(e?.message ?? e).slice(0, 120) }
    }
  }


  // 审计修复：此前 UI 调用无后端分支（/agents kill、/agents pause 必失败）——真实实现
  private async subagentInterrupt(_params: Record<string, unknown>): Promise<unknown> {
    // 中止当前回合（含运行中的子代理——agent 单实例，abort 作用于活动 turn）
    this.kernel.adapter.agent.abort()
    this.running = false
    return { ok: true, interrupted: true }
  }

  private async delegationPause(params: Record<string, unknown>): Promise<unknown> {
    // 暂停委派：中止活动回合 + 标记暂停（后续 delegate 由状态条可见暂停态）
    this.kernel.adapter.agent.abort()
    this.running = false
    const paused = params.pause !== false
    // A24 第四类修复：真实持久化——内核 get/set 双向（暂停态跨 RPC/轮询保持，
    // 新委派被内核拒绝；此前只 abort 不落状态，status 轮询即回 false）
    this.kernel.adapter.agent.setDelegationPaused?.(paused)
    this.publish({ type: 'notification.show', payload: { text: paused ? '委派已暂停' : '委派已恢复', level: 'info' } })
    return { paused }
  }

  private async spawnTreeLoad(params: Record<string, unknown>): Promise<unknown> {
    const path = String(params.path ?? '')
    try {
      const raw = readFileSync(path, 'utf8')
      const snap = JSON.parse(raw) as Record<string, any>
      return {
        finished_at: Number(snap.finished_at ?? 0),
        label: String(snap.label ?? ''),
        session_id: String(snap.session_id ?? ''),
        started_at: snap.started_at ?? null,
        subagents: Array.isArray(snap.subagents) ? snap.subagents : [],
      }
    } catch (e: any) {
      return { subagents: [], message: String(e?.message ?? e).slice(0, 120) }
    }
  }

  // ── P3 安全注入通道：sudo/secret 用户亲手输入（UI overlay）──
  // 请求表：request_id → resolve；60s 超时自动拒绝（不悬挂）
  private pendingSecrets = new Map<string, { resolve: (v: string | null) => void; timer: NodeJS.Timeout }>()

  // 向 UI 发起敏感输入请求（agent onSecretRequest 桥）：发事件 + 等 respond
  requestSecretInput(kind: 'sudo' | 'secret', prompt: string, name?: string): Promise<string | null> {
    const requestId = `sec${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingSecrets.delete(requestId)
        resolve(null) // 超时：不悬挂工具调用
      }, 60000)
      this.pendingSecrets.set(requestId, { resolve, timer })
      if (kind === 'sudo') {
        this.publish({ type: 'sudo.request', payload: { request_id: requestId }, session_id: this.currentSessionId })
      } else {
        this.publish({ type: 'secret.request', payload: { env_var: name ?? '', prompt, request_id: requestId }, session_id: this.currentSessionId })
      }
    })
  }

  private sudoRespond(params: Record<string, unknown>): unknown {
    const id = String(params.request_id ?? '')
    const p = this.pendingSecrets.get(id)
    if (!p) return { ok: false, message: '请求不存在或已超时' }
    clearTimeout(p.timer)
    this.pendingSecrets.delete(id)
    p.resolve(String(params.password ?? ''))
    return { ok: true }
  }

  private secretRespond(params: Record<string, unknown>): unknown {
    const id = String(params.request_id ?? '')
    const p = this.pendingSecrets.get(id)
    if (!p) return { ok: false, message: '请求不存在或已超时' }
    clearTimeout(p.timer)
    this.pendingSecrets.delete(id)
    p.resolve(String(params.value ?? ''))
    return { ok: true }
  }

  // ── 动态内容表：多字段敏感输入（/input 与 credential_form 工具）──
  // 请求表：request_id → resolve；120s 超时自动取消（不悬挂）；值仅经内存回传
  private pendingForms = new Map<string, { resolve: (v: Record<string, string> | null) => void; timer: NodeJS.Timeout }>()

  /** 向 UI 发起多字段敏感输入请求（动态内容表——像对话输入 key 一样） */
  requestCredentialForm(fields: Array<{ name: string; label?: string; kind: string }>, prompt?: string): Promise<Record<string, string> | null> {
    const requestId = `frm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingForms.delete(requestId)
        resolve(null) // 超时：不悬挂
      }, 120000)
      this.pendingForms.set(requestId, { resolve, timer })
      this.publish({ type: 'credential.form', payload: { request_id: requestId, fields, prompt: prompt ?? '' }, session_id: this.currentSessionId })
    })
  }

  private credentialRespond(params: Record<string, unknown>): unknown {
    const id = String(params.request_id ?? '')
    const p = this.pendingForms.get(id)
    if (!p) return { ok: false, message: '请求不存在或已超时' }
    clearTimeout(p.timer)
    this.pendingForms.delete(id)
    const values = (params.values ?? {}) as Record<string, string>
    p.resolve(values)
    return { ok: true }
  }

  // P3 图片附加链路：/image 命令（按路径附加图片）
  // 验证文件真实存在且为受支持图片（魔数），解析宽高与 token 估算，
  // 复制进会话附件目录并登记 pending——下一次 prompt.submit 随提问注入模型
  private async imageAttach(params: Record<string, unknown>): Promise<unknown> {
    const sid = String(params.session_id ?? this.currentSessionId)
    const file = String(params.path ?? '').trim()
    if (!file || !existsSync(file)) {
      return { attached: false, message: file ? `文件不存在：${file}` : '用法：/image <图片路径>' }
    }
    try {
      const { detectImageType, readImageDimensions, estimateVisionTokens } = await import('../kernel/imageMeta.js')
      const buf = readFileSync(file)
      const kind = detectImageType(buf)
      if (!kind) return { attached: false, message: '不是受支持的图片格式（PNG/JPEG/WebP/GIF）' }
      const dim = readImageDimensions(buf)
      const dir = attachmentsDir(this.kernel.dataDir, sid)
      mkdirSync(dir, { recursive: true })
      const saved = join(dir, `${Date.now()}-${basename(file).replace(/[^\w.-]/g, '_')}`)
      copyFileSync(file, saved)
      const mime = kind === 'jpeg' ? 'image/jpeg' : kind === 'webp' ? 'image/webp' : kind === 'gif' ? 'image/gif' : 'image/png'
      writePending(this.kernel.dataDir, sid, saved, mime)
      const meta = {
        attached: true, count: 1, name: basename(file),
        width: dim?.width, height: dim?.height,
        token_estimate: dim ? estimateVisionTokens(dim.width, dim.height) : 0,
        message: '图片已附加——发送消息时将随提问送入模型（视觉模型直接看图；文本模型自动经 GLM 先识别）',
      }
      this.publish({ type: 'status.update', payload: { kind: 'done', text: 'ready' } })
      return meta
    } catch (e: any) {
      return { attached: false, message: `图片附加失败：${String(e?.message ?? e).slice(0, 120)}` }
    }
  }

  // 截图即问（Ctrl+Shift+P）：全屏截图 → 附件落盘 → pending 登记——下次提问经
  // 能力门管线（视觉模型注入 parts / 文本模型 GLM 先识别）；无图形环境诚实失败
  private async captureAttach(params: Record<string, unknown>): Promise<unknown> {
    const sid = String(params.session_id ?? this.currentSessionId)
    try {
      const { captureScreen } = await import('../kernel/computer/index.js')
      const shot = await captureScreen({})
      if (!shot) return { ok: false, error: '截图不可用：原生截图模块缺失或无图形环境（CI/远程会话）' }
      const dir = attachmentsDir(this.kernel.dataDir, sid)
      mkdirSync(dir, { recursive: true })
      const saved = join(dir, `capture-${Date.now().toString(36)}.png`)
      writeFileSync(saved, shot.png)
      writePending(this.kernel.dataDir, sid, saved, 'image/png')
      return { ok: true, attached: true, file: saved, width: shot.width, height: shot.height, message: '截图已附加——发送消息时将随提问送入模型' }
    } catch (e: any) {
      return { ok: false, error: `截图附加失败：${String(e?.message ?? e).slice(0, 120)}` }
    }
  }

  // P3 图片附加链路：Ctrl+V 粘贴截图（剪贴板图片 → PNG 附件 → pending 注入）
  private async clipboardPaste(params: Record<string, unknown>): Promise<unknown> {
    const sid = String(params.session_id ?? this.currentSessionId)
    try {
      const { readClipboardImage } = await import('./lib/clipboard.js')
      const { detectImageType, readImageDimensions, estimateVisionTokens } = await import('../kernel/imageMeta.js')
      const dir = attachmentsDir(this.kernel.dataDir, sid)
      mkdirSync(dir, { recursive: true })
      const png = await readClipboardImage(dir)
      if (!png) return { attached: false, message: '未检测到剪贴板图片（Ctrl+V 粘贴图片或先截图）' }
      const buf = readFileSync(png)
      const dim = detectImageType(buf) ? readImageDimensions(buf) : null
      writePending(this.kernel.dataDir, sid, png, 'image/png')
      return {
        attached: true, count: 1, name: basename(png),
        width: dim?.width, height: dim?.height,
        token_estimate: dim ? estimateVisionTokens(dim.width, dim.height) : 0,
        message: '剪贴板图片已附加——发送消息时将随提问送入模型',
      }
    } catch (e: any) {
      return { attached: false, message: `剪贴板图片读取失败：${String(e?.message ?? e).slice(0, 120)}` }
    }
  }

  // F7 修复：session.steer 真实现（注入当前回合）
  private async sessionSteer(params: Record<string, unknown>): Promise<unknown> {
    const text = String(params.text ?? '').trim()
    if (!text) return { status: 'rejected', reason: 'empty steer text' }
    const ok = this.kernel.adapter.agent.steer(text)
    return ok ? { status: 'queued' } : { status: 'rejected', reason: 'agent not running' }
  }

  // session.undo：软归档当前会话最近一轮（自最后一个 user 消息起），对齐 CLI /undo 语义
  // 对比轮 5 修复：running 守卫（hermes 4009 拒绝）——运行中撤销会造成 DB/内存分叉
  // P3 修复：响应契约对齐 UI 消费端（core.ts 读 r.removed>0）——原死路径（永远 undefined）
  private async sessionUndo(params: Record<string, unknown>): Promise<unknown> {
    if (this.running) {
      return { ok: false, removed: 0, code: 4009, message: 'agent 运行中不能撤销——请先中断' }
    }
    const id = String(params.session_id ?? this.currentSessionId)
    const nonSys = this.kernel.adapter.data.messages.nonSystem(id)
    if (!nonSys.length) return { ok: false, removed: 0, message: '没有可撤销的消息' }
    const userIdx = nonSys.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0)
    if (!userIdx.length) return { ok: false, removed: 0, message: '没有可撤销的轮次' }
    // 撤销前自动快照（/checkpoint restore 可恢复，与 CLI /undo 一致）
    try {
      const full = this.kernel.adapter.data.messages.rows(id)
      this.kernel.adapter.data.checkpoints.save(id, { kind: 'undo-snapshot', messages: full, ts: Date.now() })
    } catch { /* 快照失败不阻断 */ }
    // 软撤销：归档而非删除（黑洞 recall 全量保留，working 窗口回退）
    const start = userIdx[userIdx.length - 1]!
    const dropIds = nonSys.slice(start).map(m => m.id)
    this.kernel.adapter.data.messages.archive(dropIds)
    this.publish({ type: 'status.update', payload: { kind: 'done', text: 'ready' } })
    return { ok: true, removed: dropIds.length, deleted_id: dropIds[dropIds.length - 1] }
  }

  // A24 第四类修复：session.fork 死 RPC 已移除——UI 只用 session.branch
  // （/branch 同链路，无 UI 调用方）；gatewayTypes 同步清理（见 gatewayTypes.ts）

  // ── A25 第四类修复：死 RPC 真实实现（/save /rollback /tools /reload /paste.collapse）──
  private async sessionSave(params: Record<string, unknown>): Promise<unknown> {
    const sid = String(params.session_id ?? this.currentSessionId)
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join: joinPath } = await import('node:path')
      const dir = joinPath(this.kernel.dataDir, 'exports')
      mkdirSync(dir, { recursive: true })
      const rows = this.loadMessages(sid)
      const lines = rows.map(m => {
        const role = m.role === 'user' ? '### 用户' : m.role === 'assistant' ? '### 助手' : m.role === 'tool' ? '### 工具' : '### 系统'
        const body = String(m.text ?? '').trim()
        return body ? `${role}\n\n${body}\n` : null
      }).filter(Boolean)
      if (!lines.length) return { ok: false, error: '会话为空——没有可导出的消息' }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const file = joinPath(dir, `session-${sid.slice(0, 8)}-${stamp}.md`)
      writeFileSync(file, `# 会话导出 ${sid}\n\n${lines.join('\n---\n\n')}\n`, 'utf8')
      return { ok: true, file }
    } catch (e: any) {
      return { ok: false, error: `导出失败：${String(e?.message ?? e).slice(0, 120)}` }
    }
  }

  // /rollback：桥接内核 checkpoints 表（与 /checkpoint 同源数据——真实快照）
  private async rollbackList(params: Record<string, unknown>): Promise<unknown> {
    try {
      const sid = String(params.session_id ?? this.currentSessionId)
      const rows = this.kernel.adapter.data.checkpoints.list(sid, 20)
      return {
        enabled: true,
        checkpoints: rows.map(r => {
          const d = JSON.parse(r.data) as { kind?: string; messages?: unknown[] }
          const n = Array.isArray(d.messages) ? d.messages.length : 0
          return {
            hash: `#${r.id}`,
            message: `${d.kind ?? 'checkpoint'}（${n} 条消息）`,
            timestamp: new Date(r.ts).toLocaleString('zh-CN', { hour12: false }),
          }
        }),
      }
    } catch { return { enabled: false, checkpoints: [] } }
  }

  private async rollbackDiff(params: Record<string, unknown>): Promise<unknown> {
    try {
      const sid = String(params.session_id ?? this.currentSessionId)
      const id = Number(String(params.hash ?? '').replace(/^#/, ''))
      if (!Number.isInteger(id) || id <= 0) return { error: `无效的快照编号：${params.hash}` }
      const row = this.kernel.adapter.data.checkpoints.get(id, sid)
      if (!row) return { error: `快照 #${id} 不存在（/rollback list 查看）` }
      const d = JSON.parse(row.data) as { messages?: Array<{ role: string; content: string }> }
      const msgs = Array.isArray(d.messages) ? d.messages : []
      const current = this.loadMessages(sid)
      const stat = `快照 ${msgs.length} 条消息 · 当前 ${current.length} 条`
      const a = msgs.map(m => `${m.role}: ${String(m.content ?? '').slice(0, 80)}`).join('\n')
      const b = current.map(m => `${m.role}: ${String(m.text ?? '').slice(0, 80)}`).join('\n')
      const rendered = a === b ? '（与当前一致）' : `快照：\n${a.slice(0, 2000)}\n\n当前：\n${b.slice(0, 2000)}`
      return { rendered, stat }
    } catch (e: any) {
      return { error: String(e?.message ?? e).slice(0, 120) }
    }
  }

  private async rollbackRestore(params: Record<string, unknown>): Promise<unknown> {
    try {
      const sid = String(params.session_id ?? this.currentSessionId)
      const id = Number(String(params.hash ?? '').replace(/^#/, ''))
      if (!Number.isInteger(id) || id <= 0) return { success: false, error: `无效的快照编号：${params.hash}` }
      const row = this.kernel.adapter.data.checkpoints.get(id, sid)
      if (!row) return { success: false, error: `快照 #${id} 不存在（/rollback list 查看）` }
      const d = JSON.parse(row.data) as { messages?: Array<{ id?: number; role: string; content: string; tool_call_id?: string | null; archived?: number; ts?: number }> }
      if (!Array.isArray(d.messages)) return { success: false, error: '快照数据不完整' }
      const before = this.kernel.adapter.data.messages.count(sid)
      // A25：统一恢复函数——清理 FTS 旧行 + 重置 AUTOINCREMENT 序列再重插
      // （此前手写 DELETE+重插：FTS5 触发器使同 rowid 重插 constraint failed）
      this.kernel.adapter.data.messages.replace(sid, d.messages)
      this.publish({ type: 'session.info', payload: this.buildInfo() })
      return { success: true, restored_to: `#${id}`, history_removed: before, reason: `已从快照 #${id} 恢复 ${d.messages.length} 条消息` }
    } catch (e: any) {
      return { success: false, error: String(e?.message ?? e).slice(0, 120) }
    }
  }

  // /tools enable|disable：内置工具集启用/禁用（updateTools 热生效——真实状态持久于进程内）
  private async toolsConfigure(params: Record<string, unknown>): Promise<unknown> {
    const action = String(params.action ?? '')
    const names = Array.isArray(params.names) ? params.names.map(String) : []
    if (!names.length) return { unknown: ['（未指定工具集）'] }
    try {
      const { coreTools } = await import('../kernel/tools.js')
      const all = Object.keys(coreTools())
      const disabled = new Set<string>(this.toolDisableSet ?? [])
      const changed: string[] = []
      const unknown: string[] = []
      for (const name of names) {
        const tools = all.filter(t => t.startsWith(name.replace(/-/g, '_')))
        if (!tools.length) { unknown.push(name); continue }
        for (const t of tools) {
          if (action === 'disable') disabled.add(t)
          else disabled.delete(t)
          changed.push(t)
        }
      }
      this.toolDisableSet = disabled
      const base = { ...coreTools() }
      for (const t of disabled) delete base[t]
      this.kernel.adapter.agent.updateTools?.(base)
      this.publish({ type: 'session.info', payload: this.buildInfo() })
      return { changed: [...new Set(changed)], unknown }
    } catch (e: any) {
      return { unknown: [`配置失败：${String(e?.message ?? e).slice(0, 120)}`] }
    }
  }

  // /reload：重读 .env 到 process.env（真实合并计数——不伪造）
  private async reloadEnv(_params: Record<string, unknown>): Promise<unknown> {
    try {
      const { readFileSync, existsSync } = await import('node:fs')
      const { join: joinPath } = await import('node:path')
      const candidates = [joinPath(this.kernel.dataDir, '.env'), joinPath(this.kernel.cwd, '.env')]
      let updated = 0
      for (const p of candidates) {
        if (!existsSync(p)) continue
        const raw = readFileSync(p, 'utf8')
        for (const line of raw.split(/\r?\n/)) {
          const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
          if (!m || line.trim().startsWith('#')) continue
          const key = m[1]!
          const value = m[2]!.replace(/^["']|["']$/g, '')
          if (process.env[key] !== value) { process.env[key] = value; updated++ }
        }
      }
      return { updated }
    } catch (e: any) {
      return { updated: 0, error: String(e?.message ?? e).slice(0, 120) }
    }
  }

  // paste.collapse：大段粘贴落盘为临时文件（路径回显——模型可读长文本；
  // 此前 RPC 不存在导致静默失败、snippet 永不标注路径）
  private async pasteCollapse(params: Record<string, unknown>): Promise<unknown> {
    const text = String(params.text ?? '')
    if (!text.trim()) return { path: undefined }
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join: joinPath } = await import('node:path')
      const dir = joinPath(this.kernel.dataDir, 'paste')
      mkdirSync(dir, { recursive: true })
      const file = joinPath(dir, `paste-${Date.now().toString(36)}.txt`)
      writeFileSync(file, text, 'utf8')
      return { path: file }
    } catch { return { path: undefined } }
  }

  private async sessionActiveList(params: Record<string, unknown>): Promise<unknown> {
    const current = String(params.current_session_id ?? '')
    let rows: any[] = []

    try {
      rows = this.kernel.adapter.data.sessions.list(20)
    } catch {
      rows = []
    }
    // A25：会话状态真实化——当前会话且回合运行中 → working；后台任务表存在该
    // 会话运行/排队任务 → waiting；否则 idle（此前恒 idle——working/waiting
    // 字形与配色分支永不出现）
    let sessionHasBgTask = (_sid: string): boolean => false
    try {
      sessionHasBgTask = sid => {
        if (sid !== current) return false
        return this.kernel.adapter.data.tasks.hasRunningOrQueued(current)
      }
    } catch { /* 任务表不可用按无 */ }
    const sessions = rows.map((r: any) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      current: String(r.id) === current,
      started_at: Number(r.created_at ?? 0) / 1000,
      message_count: Number(r.message_count ?? 0),
      model: this.kernel.settings.model ?? '',
      ...(typeof r.cost_usd === 'number' ? { cost_usd: r.cost_usd } : {}),
      status:
        String(r.id) === current && this.running
          ? ('working' as const)
          : sessionHasBgTask(String(r.id))
            ? ('waiting' as const)
            : ('idle' as const),
    }))

    return { sessions }
  }

  // 审计修复：session.list 真实实现（此前 UI 调用无后端分支——可恢复会话区恒报错）
  // 与 session.active_list 同源（DB 查询），历史会话也可恢复
  private async sessionList(params: Record<string, unknown>): Promise<unknown> {
    const current = String(params.current_session_id ?? '')
    const limit = Math.min(Number(params.limit ?? 200) || 200, 500)
    let rows: any[] = []
    try {
      rows = this.kernel.adapter.data.sessions.list(limit)
    } catch {
      rows = []
    }
    const sessions = rows.map((r: any) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      current: String(r.id) === current,
      created_at: Number(r.created_at ?? 0) / 1000,
      updated_at: Number(r.updated_at ?? 0) / 1000,
      message_count: Number(r.message_count ?? 0),
      ...(typeof r.cost_usd === 'number' ? { cost_usd: r.cost_usd } : {}),
    }))
    return { sessions }
  }

  /** 交互式 diff 查看（2026-08-19 A/B 收口）：turn 源结构化视图——快照基线 + 当前 + 渲染行 + hunk 数
   * v2（③ 残留收口）：无 file 参数 = 全文件集聚合视图（文件分节 + 分节元数据 + ✓ 审阅标记） */
  private async diffView(params: Record<string, unknown>): Promise<unknown> {
    const file = String(params.file ?? '').trim()
    const { existsSync, readFileSync } = await import('node:fs')
    const { lineDiff, parseHunks } = await import('../kernel/hunkApply.js')
    const { versionsOfFile, listShadows } = await import('../kernel/undoShadows.js')
    const { loadDiffReviewed, hunkFingerprint } = await import('../kernel/diffReviewed.js')
    const { resolve } = await import('node:path')
    const reviewed = loadDiffReviewed(this.kernel.dataDir)
    const cwd = this.kernel.cwd

    // 收集变更文件集（相对路径 → {abs, base}）：单文件 or cwd 内全部有快照文件
    const targets: Array<{ abs: string; rel: string; base: string }> = []
    if (file) {
      const abs = resolve(cwd, file)
      if (!existsSync(abs)) return { ok: false, error: `文件不存在：${file}` }
      const versions = versionsOfFile(this.kernel.dataDir, abs)
      if (!versions.length) return { ok: false, error: '该文件无编辑快照（turn 源需先经 fs_edit/fs_write 编辑过；git 源请用 /diff <文件> git）' }
      targets.push({ abs, rel: file, base: versions[0]!.content })
    } else {
      const norm = (p: string) => p.replace(/\\/g, '/')
      const cwdNorm = norm(cwd)
      const latest = new Map<string, { content: string; ts: number }>()
      for (const s of listShadows(this.kernel.dataDir)) {
        if (!norm(s.path).startsWith(cwdNorm + '/')) continue
        const prev = latest.get(s.path)
        if (!prev || s.ts > prev.ts) latest.set(s.path, { content: s.content, ts: s.ts })
      }
      for (const [path, base] of latest) {
        if (!existsSync(path)) continue
        targets.push({ abs: path, rel: norm(path).startsWith(cwdNorm + '/') ? norm(path).slice(cwdNorm.length + 1) : path, base: base.content })
      }
      targets.sort((a, b) => a.rel.localeCompare(b.rel))
      if (!targets.length) return { ok: false, error: '无会话编辑快照——turn 源需要先经 fs_edit/fs_write 编辑过（git 源可用 /diff <文件> git）' }
    }

    // 逐文件构建分节：header + diff 行；已审 hunk 头部追加 ✓ 标记（不破坏 @@ 检测正则）
    const lines: string[] = []
    const sections: Array<{ abs: string; rel: string; hunks: number; start: number; end: number }> = []
    let changedFiles = 0
    for (const t of targets) {
      let cur = ''
      try { cur = readFileSync(t.abs, 'utf8') } catch { continue }
      const d = lineDiff(t.base, cur)
      if (!d) continue
      const hunks = parseHunks(d)
      const start = lines.length
      lines.push(`▶ ${t.rel}（${hunks.length} hunk${hunks.length > 1 ? 's' : ''}）`, '')
      for (const h of hunks) {
        const mark = reviewed.marks[t.abs]?.[hunkFingerprint(h)] ? '  ✓' : ''
        lines.push(h.header + mark)
        for (const l of h.lines) lines.push((l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
      }
      sections.push({ abs: t.abs, rel: t.rel, hunks: hunks.length, start, end: lines.length })
      changedFiles++
    }
    if (!changedFiles) return { ok: false, error: '会话内编辑过的文件与当前无差异（或已被还原）' }

    return {
      ok: true,
      aggregate: !file,
      file: file || undefined,
      changedFiles,
      sections: sections.map(s => ({ abs: s.abs, rel: s.rel, hunks: s.hunks, start: s.start, end: s.end })),
      lines,
    }
  }

  /** 交互式逐 hunk 回滚（无状态：基线=最新快照、当前=磁盘——每次重算，序号即序数） */
  private async diffRevert(params: Record<string, unknown>): Promise<unknown> {
    const file = String(params.file ?? '').trim()
    const hunkIndex = Number(params.hunk_index ?? NaN)
    if (!Number.isInteger(hunkIndex) || hunkIndex < 1) return { ok: false, error: 'hunk 序号非法' }
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
    if (!file || !existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
    const { lineDiff, parseHunks, applyHunkToText, reverseHunk } = await import('../kernel/hunkApply.js')
    const { versionsOfFile, snapshotFile } = await import('../kernel/undoShadows.js')
    const versions = versionsOfFile(this.kernel.dataDir, file)
    if (!versions.length) return { ok: false, error: '无快照可回滚' }
    const cur = readFileSync(file, 'utf8')
    const hunks = parseHunks(lineDiff(versions[0]!.content, cur))
    const h = hunks[hunkIndex - 1]
    if (!h) return { ok: false, error: `hunk ${hunkIndex} 不存在（共 ${hunks.length} 个）` }
    const r = applyHunkToText(cur, reverseHunk(h))
    if (!r.ok) return { ok: false, error: `回滚失败：${r.error}` }
    snapshotFile(this.kernel.dataDir, file, cur)
    writeFileSync(file, r.text, 'utf8')
    return { ok: true, output: `已回滚 hunk ${hunkIndex}/${hunks.length}（快照已留存，/undo fs restore 可再滚回）` }
  }

  /** mark-reviewed（③ 残留收口）：逐 hunk 审阅标记——内容指纹持久化（变更即失效，不跟随漂移） */
  private async diffMark(params: Record<string, unknown>): Promise<unknown> {
    const file = String(params.file ?? '').trim()
    const hunkIndex = Number(params.hunk_index ?? NaN)
    if (!Number.isInteger(hunkIndex) || hunkIndex < 1) return { ok: false, error: 'hunk 序号非法' }
    const { existsSync, readFileSync } = await import('node:fs')
    if (!file || !existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
    const { lineDiff, parseHunks } = await import('../kernel/hunkApply.js')
    const { versionsOfFile } = await import('../kernel/undoShadows.js')
    const { markHunkReviewed, hunkFingerprint } = await import('../kernel/diffReviewed.js')
    const versions = versionsOfFile(this.kernel.dataDir, file)
    if (!versions.length) return { ok: false, error: '无快照（turn 源需先经 fs_edit/fs_write 编辑过）' }
    const hunks = parseHunks(lineDiff(versions[0]!.content, readFileSync(file, 'utf8')))
    const h = hunks[hunkIndex - 1]
    if (!h) return { ok: false, error: `hunk ${hunkIndex} 不存在（共 ${hunks.length} 个）` }
    markHunkReviewed(this.kernel.dataDir, file, hunkFingerprint(h))
    return { ok: true, output: `已标记审阅 hunk ${hunkIndex}/${hunks.length}` }
  }

  private async sessionTail(params: Record<string, unknown>): Promise<unknown> {
    // 会话尾部消息（2026-08-19 会话浏览器惰性展开预览，codex resume_picker 惰性加载对标）
    const id = String(params.session_id ?? '')
    const limit = Math.min(Math.max(Number(params.limit ?? 6) || 6, 1), 20)
    let rows: any[] = []
    try {
      rows = this.kernel.adapter.data.messages.rows(id)
    } catch {
      rows = []
    }
    const tail = rows
      .filter((r: any) => !r.archived && (r.role === 'user' || r.role === 'assistant'))
      .slice(-limit)
      .map((r: any) => ({ role: String(r.role), text: String(r.content ?? '') }))
    return { messages: tail }
  }

  private async sessionMostRecent(): Promise<unknown> {
    let row: any = null

    try {
      row = this.kernel.adapter.data.sessions.mostRecent() ?? null
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

    this.kernel.adapter.data.sessions.rename(id, title)

    return { title }
  }

  private async sessionInterrupt(): Promise<unknown> {
    this.kernel.adapter.agent.abort()
    this.running = false

    return { ok: true }
  }

  // ── 审计修复：此前 UI 命令（/compress /branch /background /stop）调用的
  // RPC 无后端分支——slashRegistry 被迫移除命令导致「未知命令」；现全部真实实现 ──
  private async sessionCompress(params: Record<string, unknown>): Promise<unknown> {
    // 内核真实压缩（当前会话；有 key 时 LLM 总结，无 key 规则降级——与 /compact 同路径）
    try {
      await this.kernel.commandBus.execute('/compact')
    } catch { /* 压缩失败不阻断返回 */ }
    const sid = String(params.session_id ?? this.currentSessionId)
    const rows = this.loadMessages(sid)
    // A24 第三类修复：返回真实 usage（含压缩计数——此前硬编码空对象，/compress 的
    // 「· N tok」提示从未出现）
    const info = this.buildInfo()
    return { messages: rows, info, usage: info.usage }
  }

  private async sessionBranch(params: Record<string, unknown>): Promise<unknown> {
    const src = String(params.session_id ?? this.currentSessionId)
    const name = String(params.name ?? '').trim()
    const newId = `s${Date.now()}b`
    try {
      if (!this.kernel.adapter.data.sessions.branch(src, newId, name || `${src} branch`)) return { error: '会话不存在' }
    } catch (e: any) {
      return { error: String(e?.message ?? e).slice(0, 120) }
    }
    this.currentSessionId = newId
    this.kernel.adapter.agent.setSessionId(newId)
    return { session_id: newId, title: name || `${src} branch`, messages: this.loadMessages(newId), info: this.buildInfo() }
  }

  private async promptBackground(params: Record<string, unknown>): Promise<unknown> {
    const text = String(params.text ?? '').trim()
    if (!text) return { task_id: null }
    const taskId = `bg${Date.now().toString(36)}`
    try {
      this.kernel.adapter.data.tasks.insert(taskId, text.slice(0, 200))
    } catch { /* 任务表不可用：仅内存执行 */ }
    // 后台执行（不阻塞 RPC）：agent.run 完成后发 background.complete（UI 移除 bg 徽标）
    void this.kernel.adapter.agent.run(text).then(r => {
      try {
        this.kernel.adapter.data.tasks.markDone(taskId, String(r.text ?? '').slice(0, 2000))
      } catch { /* 忽略 */ }
      this.publish({ type: 'background.complete', payload: { task_id: taskId, text: String(r.text ?? '') } })
    })
    return { task_id: taskId }
  }

  private async processStop(): Promise<unknown> {
    // 停止全部后台任务：中止当前回合 + 任务表标记 done（/jobs 可见）
    this.kernel.adapter.agent.abort()
    let killed = 0
    try {
      killed = this.kernel.adapter.data.tasks.markAllRunningDone()
    } catch { /* 任务表不可用 */ }
    return { killed }
  }

  // W2-02：个性化服务懒加载单例（user config.json + workspace .wxnodus/config.yaml）
  private personalizationService: PersonalizationService | null = null
  private getPersonalization(): PersonalizationService {
    if (!this.personalizationService) {
      this.personalizationService = new PersonalizationService(new ConfigRepository({
        userFile: join(this.kernel.dataDir, 'config.json'),
        workspaceFile: join(this.kernel.cwd, '.wxnodus', 'config.yaml'),
      }))
    }
    return this.personalizationService
  }

  /** W2-02：个性化/全量配置 RPC——真实 service，失败返回 OperationResult（绝不假成功） */
  private async personalizationRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const handlers = createPersonalizationRpcHandlers({
      service: this.getPersonalization(),
      readFullConfig: async () => ({ ...(this.kernel.settings ?? {}) }),
    })
    const handler = handlers[method]
    if (!handler) throw new Error(`unsupported rpc: ${method}`)
    return handler(params)
  }

  // ── 配置面板 RPC（2026-08-19）：真实 settings 清单（密钥掩码）+ 白名单校验设置 ──
  private configListSettings(): unknown {
    const s = (this.kernel.config.get('settings') ?? {}) as Record<string, any>;
    const safe = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'apiKeyEnc' ? (v ? 'enc:****' : '') : v]));
    return { settings: safe, known: knownSettingsKeys() };
  }

  private configSetSetting(params: Record<string, unknown>): unknown {
    const key = String(params.key ?? '');
    const raw = String(params.value ?? '');
    if (!knownSettingsKeys().includes(key)) return { ok: false, error: `未知配置键「${key}」——/config set 仅接受白名单键` };
    const value: any = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : !Number.isNaN(Number(raw)) && raw !== '' ? Number(raw) : raw;
    this.kernel.config.setKey('settings', key, value);
    this.publish({ type: 'notification.show', payload: { text: `已设置 ${key} = ${JSON.stringify(value)}`, level: 'info' } });
    return { ok: true, key, value };
  }

  private configGet(params: Record<string, unknown>): unknown {
    const key = String(params.key ?? '')

    if (key === 'mtime') {
      // A25：真实配置文件 mtime（此前硬编码 0——useConfigWatcher 的配置热生效
      // 轮询被永久禁用，手工改 settings.json 永不触发 reload MCP）
      try {
        const f = join(this.kernel.dataDir, 'settings.json')
        const st = statSync(f)
        return { mtime: Math.floor(st.mtimeMs) }
      } catch {
        return { mtime: 0 }
      }
    }

    const s = this.kernel.settings as Record<string, any>

    // KF-002：key='full' 返回完整配置快照（settings + 运行环境）——绝不返回 undefined 包装
    if (key === 'full') {
      return { full: { ...(s ?? this.kernel.config.get('settings') ?? {}), dataDir: this.kernel.dataDir, cwd: this.kernel.cwd } };
    }

    // 审计修复：单键查询按真实 settings 返回（此前任意 key 都返回 'interrupt' 假值）
    if (key) {
      if (key === 'skin') return { value: s.skin ?? 'default' }
      if (key === 'lang') return { value: s.lang ?? 'zh' }
      if (key === 'theme') return { value: s.theme ?? 'wxnodus' }
      if (key === 'busy' || key === 'busy_input_mode') return { value: s.busy_input_mode ?? 'interrupt' }
      if (key === 'thinking' || key === 'reasoning') return { value: s.thinking !== false }
      if (key === 'mode') return { value: s.mode ?? 'smart' }
      if (key === 'model') return { value: s.model ?? resolveDefaultModel(s) }
      return { value: s[key] ?? undefined } // 未知键如实返回 undefined（不再伪造）
    }

    // 审计修复：display 从真实配置生成（此前全硬编码——/busy 等设置永不读回，
    // 且 'bottom' 会覆盖 UI 默认 'top'）；每键读 settings、缺省走文档默认值（真默认而非写死）
    const display: Record<string, unknown> = {
      bell_on_complete: s.bell_on_complete ?? false,
      details_mode: s.details_mode ?? 'collapsed',
      inline_diffs: s.inline_diffs ?? true,
      mouse_tracking: s.mouse_tracking ?? 'all',
      show_cost: s.show_cost ?? false,
      show_reasoning: s.thinking !== false,
      streaming: s.streaming ?? true,
      tui_compact: s.tui_compact ?? false,
      tui_status_indicator: s.tui_status_indicator ?? 'kaomoji',
    }
    if (s.busy_input_mode) display.busy_input_mode = s.busy_input_mode
    if (s.tui_statusbar) display.tui_statusbar = s.tui_statusbar

    return {
      config: {
        display,
        paste_collapse_threshold: 5,
        paste_collapse_char_threshold: 2000,
        // supremacy 3.3：键位配置层透出（settings.keymap JSON——TUI 水合后热生效）
        ...(s.keymap ? { keymap: s.keymap } : {}),
      },
      value: s.busy_input_mode ?? 'interrupt',
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
      // A12：模型切换可见反馈（通知机制）
      this.publish({ type: 'notification.show', payload: { text: `已切换模型：${hit ? hit.modelId : modelId}`, level: 'info' } })
    } else if (key === 'mode') {
      this.kernel.setMode(value)
      this.kernel.adapter.agent.setMode(value)
    } else if (key === 'theme') {
      this.kernel.setTheme(value)
    } else if (key === 'thinking' || key === 'reasoning') {
      // C5 修复：/reasoning 命令映射 thinking（此前假成功零效果）
      this.kernel.setThinking(value === 'true' || value === 'on' || value === '1')
    } else if (key === 'busy') {
      // C7：/busy 命令接入（queue/interrupt/steer 三模式；写入 settings 供状态条显示）
      // 键名与配置白名单归一（busy_input_mode，snake_case 单一事实源）
      ;(s as Record<string, any>).busy_input_mode = ['queue', 'interrupt', 'steer'].includes(value) ? value : 'interrupt'
      this.kernel.config.setKey('settings', 'busy_input_mode', (s as Record<string, any>).busy_input_mode)
    } else if (key === 'busy_input_mode') {
      ;(s as Record<string, any>).busy_input_mode = ['queue', 'interrupt', 'steer'].includes(value) ? value : 'interrupt'
      this.kernel.config.setKey('settings', 'busy_input_mode', (s as Record<string, any>).busy_input_mode)
    } else if (key === 'indicator') {
      ;(s as Record<string, any>).tui_status_indicator = value
      this.kernel.config.setKey('settings', 'tui_status_indicator', value)
    } else if (key === 'statusbar') {
      ;(s as Record<string, any>).tui_statusbar = value
      this.kernel.config.setKey('settings', 'tui_statusbar', value)
    } else if (key === 'skin') {
      // 开放兼容：/skin <名称> 真实生效——落盘 settings.skin + 广播 skin.changed
      // （前端 eventAdapter applySkin 已有，缺数据源——此处分发皮肤对象）
      ;(s as Record<string, any>).skin = value
      this.kernel.config.setKey('settings', 'skin', value)
      const skin = loadSkinFile(this.kernel.dataDir, value)
      this.publish({ type: 'skin.changed', payload: skin ?? {} })
    } else if (key === 'theme') {
      // 开放兼容：/theme dark|light|wxnodus 真实生效（此前仅存字符串无 UI 效果）
      this.kernel.setTheme(value)
      this.publish({ type: 'theme.changed', payload: { name: value } })
    }

    return { value: s[key as keyof typeof s] ?? value }
  }

  private setupStatus(): unknown {
    const s = this.kernel.settings
    // A25：诚实返回真实配置状态（此前硬编码 true——UI 的「setup required」门禁
    // 永不触发是设计意图，但返回值造假）。无 key 时本地离线模型仍可用，
    // 由 UI 端改为提示继续而非阻塞。
    const configured = Boolean(s.apiKeyEnc)

    if (configured) {
      const fallback = MODEL_CATALOG.find((m) => m.modelId === resolveDefaultModel(s)) ?? MODEL_CATALOG[2]
      // model 缺失或非法（遗留命令串）→ 回退默认 modelId
      if (!s.model || !MODEL_CATALOG.some((m) => m.modelId === s.model)) s.model = fallback.modelId
      if (!s.baseURL) s.baseURL = fallback.baseURL
    }

    return { provider_configured: configured }
  }

  private approvalRespond(params: Record<string, unknown>): unknown {
    const choice = String(params.choice ?? 'deny')

    if (this.pendingApproval) {
      this.pendingApproval.resolve(choice)
      this.pendingApproval = null
    }

    return { ok: true }
  }

  // C6 修复：clarify 文字提问（独立 pending——不占用审批通道；激活 UI clarify 死分支）
  requestClarify(question: string, choices?: string[]): Promise<string> {
    return new Promise((resolve) => {
      this.pendingClarify = { resolve }
      this.publish({
        type: 'clarify.request',
        payload: { choices: choices ?? null, question, request_id: `clr-${Date.now().toString(36)}` },
      })
    })
  }

  private clarifyRespond(params: Record<string, unknown>): unknown {
    const answer = String(params.answer ?? '')

    if (this.pendingClarify) {
      this.pendingClarify.resolve(answer)
      this.pendingClarify = null
    } else if (this.pendingApproval) {
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

  // ── 语音模式（本地 whisper：真实实现，非占位）──────────────
  // A20：VAD 免提——start 时 vad:true → 静音自动停止（onVadEnded）
  /** A20：语音密钥待命——用户说"设置密钥"后，下一段语音直接作为密钥录入 */
  private voicePendingSecret = false

  /** A22 连续对话 re-arm：语音模式开 + 非唤醒态（唤醒有独立监听闭环）时，
   *  agent 回答结束后自动再开 VAD 待命——多轮免提对话无需按键。 */
  private scheduleVoiceRearm(delayMs = 700): void {
    if (this.voiceRearmTimer) {
      return
    }

    this.voiceRearmTimer = setTimeout(() => {
      this.voiceRearmTimer = null

      if (!this.voiceEnabled || this.voiceWake || !this.voiceContinuousArmed) {
        return
      }
      if (this.voiceRecordingSession || this.voiceTranscribing) {
        return
      }

      this.speak('请说')
      void this.voiceRecord({ action: 'start', vad: true })
    }, delayMs)
  }

  private resetVoiceContinuous(): void {
    this.voiceContinuousArmed = false
    this.voiceNoSpeechStreak = 0
    if (this.voiceRearmTimer) {
      clearTimeout(this.voiceRearmTimer)
      this.voiceRearmTimer = null
    }
  }
  /** A20：唤醒监听器（/voice wake on） */
  private wakeListener: import('../kernel/wake.js').WakeListener | null = null
  private voiceWake = false
  /** A20：工具状态播报节流（1.5s 内只播一条） */
  private lastToolSpeakAt = 0
  // ── A22 连续对话（多轮免提）：agent.end 后自动 re-arm VAD 待命 ──
  private voiceContinuousArmed = false
  private voiceNoSpeechStreak = 0
  private voiceRearmTimer: ReturnType<typeof setTimeout> | null = null

  private voiceToggle(params: Record<string, unknown>): unknown {
    const action = String(params.action ?? 'status')
    const settings = this.kernel.config.get('settings') as Record<string, any> | undefined
    const check = checkVoice(settings, this.kernel.dataDir)

    if (action === 'on') {
      this.voiceEnabled = true
      if (!check.sttAvailable) {
        this.publish({ type: 'notification.show', payload: { text: '语音模式已开启，但 STT 组件缺失（/voice status 查看）', level: 'warn' } })
      }
    } else if (action === 'off') {
      this.voiceEnabled = false
      // A22：关闭语音同时停掉连续对话 re-arm 循环
      this.resetVoiceContinuous()
      // 录制中关闭：停止采集
      if (this.voiceRecordingSession) {
        this.voiceRecordingSession.proc.kill('SIGKILL')
        this.voiceRecordingSession = null
        this.publish({ type: 'voice.status', payload: { state: 'idle' } })
      }
      // A20：关闭语音同时停掉唤醒监听
      if (this.wakeListener) {
        this.wakeListener.stop()
        this.wakeListener = null
        this.voiceWake = false
      }
    } else if (action === 'tts') {
      this.voiceTts = !this.voiceTts
      // A25 复查：开启 TTS 时一次性探测 Windows SAPI（powershell + System.Speech）——
      // 失败如实通知（此前无条件返回 true，用户以为有播报实际从未出声）
      if (this.voiceTts) {
        // W3-11：SAPI 探测经 kernel/voice 集中委托（入口层不直接执行进程）
        void import('../kernel/voice.js').then(({ probeSapiTtsAvailable }) => {
        if (!probeSapiTtsAvailable()) {
          this.voiceTts = false
          this.publish({ type: 'notification.show', payload: { text: 'TTS 不可用：Windows 语音组件（System.Speech）缺失或 powershell 不可用——播报已关闭', level: 'warn' } })
        }
        })
      }
    } else if (action === 'wake') {
      // 异步启停（动态 import）；当前状态先翻转展示，失败会回滚
      this.voiceWake = !this.voiceWake
      void this.toggleWake()
    }

    return {
      enabled: this.voiceEnabled,
      tts: this.voiceTts,
      wake: this.voiceWake,
      audio_available: check.sttAvailable,
      stt_available: check.sttAvailable,
      details: check.details.join('\n'),
      // 审计修复：record_key 从配置读（settings.voice.recordKey，缺省 ctrl+b）——
      // 前端 /voice status 与热键绑定保持一致
      record_key: (settings?.voice as Record<string, any> | undefined)?.recordKey ?? 'ctrl+b',
    }
  }

  /** A20：唤醒模式启停（持续监听 + whisper 短窗匹配——纯自研） */
  private async toggleWake(): Promise<void> {
    if (this.wakeListener) {
      this.wakeListener.stop()
      this.wakeListener = null
      this.voiceWake = false

      return
    }

    const settings = this.kernel.config.get('settings') as Record<string, any> | undefined
    const { resolveVoiceConfig, detectAudioDevice } = await import('../kernel/voice.js')
    const cfg = resolveVoiceConfig(settings, this.kernel.dataDir)
    const device = cfg.device || detectAudioDevice()

    if (!cfg.whisperBin || !cfg.modelPath || !device) {
      this.voiceWake = false
      this.publish({ type: 'notification.show', payload: { text: '唤醒模式不可用：缺少 whisper/模型/录音设备（/voice status 查看）', level: 'warn' } })

      return
    }

    const { WakeListener } = await import('../kernel/wake.js')
    // A22：唤醒词可配（settings.voice.wakeWords；缺省 wxnodus/唤醒/wake）
    const voice = (settings?.voice as Record<string, any> | undefined) ?? {}
    const wakeWords = Array.isArray(voice.wakeWords) ? voice.wakeWords.map(String).filter(Boolean) : undefined
    this.wakeListener = new WakeListener({
      dataDir: this.kernel.dataDir,
      whisperBin: cfg.whisperBin,
      modelPath: cfg.modelPath,
      device,
      ...(wakeWords?.length ? { wakeWords } : {}),
      onWake: () => {
        // 唤醒命中：播报"我在" + 自动进入 VAD 待命录音（免提闭环）
        if (this.voiceTts) {
          void import('../kernel/voice.js').then(({ speakTts }) => {
            try { speakTts('我在，请说') } catch { /* 忽略 */ }
          })
        }
        void this.voiceRecord({ action: 'start', vad: true })
      },
      onError: (e) => this.publish({ type: 'notification.show', payload: { text: e, level: 'warn' } }),
    })
    const r = this.wakeListener.start()

    if (!r.ok) {
      this.wakeListener = null
      this.voiceWake = false
      this.publish({ type: 'notification.show', payload: { text: r.error, level: 'warn' } })

      return
    }

    this.publish({ type: 'notification.show', payload: { text: '唤醒模式已开启——说「wxnodus」唤醒（持续监听，CPU 有开销）', level: 'success' } })
  }

  /** A20：语音播报（voiceTts 门控 + 静默失败——附加能力不阻塞主流程） */
  private speak(text: string): void {
    if (!this.voiceTts) {
      return
    }
    void import('../kernel/voice.js').then(({ speakTts }) => {
      try { speakTts(text) } catch { /* 忽略 */ }
    })
  }

  /** A20：工具状态播报（开始执行时，1.5s 节流） */
  private speakToolStart(name: string): void {
    const now = Date.now()

    if (now - this.lastToolSpeakAt < 1500) {
      return
    }
    this.lastToolSpeakAt = now
    this.speak(`正在执行 ${name}`)
  }

  /** A20：语音密钥专用通道——转写含敏感内容时拦截，不进历史/模型/显示 */
  private async routeVoiceSecret(text: string): Promise<boolean> {
    const { detectSecretInTranscript } = await import('../kernel/secretDetect.js')
    const hit = detectSecretInTranscript(text)

    if (!hit) {
      return false
    }

    if (this.voicePendingSecret) {
      // 上一轮引导后：整段语音就是密钥
      this.voicePendingSecret = false
      const r = await this.kernel.commandBus.execute(`/key set ${hit.secret || text}`)

      if (r.ok) {
        this.publish({ type: 'notification.show', payload: { text: '语音密钥已安全录入（AES 加密存储，不回显）', level: 'success' } })
        this.speak('密钥已安全录入')
      } else {
        this.publish({ type: 'notification.show', payload: { text: `密钥录入失败：${r.output ?? '未知错误'}`, level: 'error' } })
      }

      return true
    }

    if (hit.secret) {
      // 转写直接含密钥（"设置密钥 sk-xxx" / "sk-xxx"）→ 本地加密存储
      const r = await this.kernel.commandBus.execute(`/key set ${hit.secret}`)

      if (r.ok) {
        this.publish({ type: 'notification.show', payload: { text: '语音密钥已安全录入（AES 加密存储，不回显）', level: 'success' } })
        this.speak('密钥已安全录入')
      } else {
        this.publish({ type: 'notification.show', payload: { text: `密钥录入失败：${r.output ?? '未知错误'}`, level: 'error' } })
      }
    } else {
      // 只说"设置密钥"无内容 → 引导下一段语音作为密钥
      this.voicePendingSecret = true
      this.publish({ type: 'notification.show', payload: { text: '请说出密钥（下段语音将作为密钥安全录入）', level: 'warn' } })
      this.speak('请说出密钥')
    }

    return true
  }

  /** A20：录音收尾（手动 stop 与 VAD 自动停止共用）——转写 + 敏感拦截 + 事件广播 */
  private async finishVoiceRecording(): Promise<{ status: string; text: string }> {
    const rec = this.voiceRecordingSession

    if (!rec) {
      return { status: 'stopped', text: '' }
    }
    this.voiceRecordingSession = null
    this.voiceTranscribing = true
    this.publish({ type: 'voice.status', payload: { state: 'transcribing' } })
    const settings = this.kernel.config.get('settings') as Record<string, any> | undefined
    const { stopVoiceTranscribe } = await import('./runtime/voiceRpc.js')
    const r = await stopVoiceTranscribe(rec, this.kernel.dataDir, settings)
    this.voiceTranscribing = false
    this.publish({ type: 'voice.status', payload: { state: 'idle' } })

    if (!r.ok) {
      this.publish({ type: 'notification.show', payload: { text: `转写失败：${r.error}`, level: 'error' } })

      return { status: 'stopped', text: '' }
    }

    if (r.text) {
      // A20 红线：敏感检测——密钥/口令走专用通道（不进历史/模型/显示）
      const intercepted = await this.routeVoiceSecret(r.text)

      if (!intercepted) {
        this.publish({ type: 'voice.transcript', payload: { text: r.text } })
      }

      // A22 连续对话：听到语音 → 清空无语音计数，继续待命
      if (this.voiceContinuousArmed) {
        this.voiceNoSpeechStreak = 0
        this.scheduleVoiceRearm(500)
      }

      return { status: 'stopped', text: r.text }
    }

    // A22 连续对话：3 次无语音 → 自动停 + no_speech_limit 事件（UI 侧
    // 已具备处理分支——此前网关永不发布，死代码今天激活）
    if (this.voiceContinuousArmed) {
      this.voiceNoSpeechStreak++
      if (this.voiceNoSpeechStreak >= 3) {
        this.voiceEnabled = false
        this.voiceContinuousArmed = false
        this.publish({ type: 'voice.transcript', payload: { no_speech_limit: true, text: '' } })
        this.publish({
          type: 'notification.show',
          payload: { text: '连续 3 次未听到语音——连续对话已暂停（/voice on 或唤醒词恢复）', level: 'warn' },
        })
      } else {
        this.scheduleVoiceRearm(600)
      }
    }

    return { status: 'stopped', text: '' }
  }

  private async voiceRecord(params: Record<string, unknown>): Promise<unknown> {
    const action = String(params.action ?? '')
    const settings = this.kernel.config.get('settings') as Record<string, any> | undefined

    if (action === 'start') {
      if (this.voiceTranscribing) return { status: 'busy' }
      if (this.voiceRecordingSession) return { status: 'recording' }
      const { startVoiceRecording } = await import('./runtime/voiceRpc.js')
      // A20：免提模式——/voice on 后默认 VAD（静音自动停止）；参数可关闭
      const vad = params.vad !== false && this.voiceEnabled
      // A22：VAD 参数可配（settings.voice.vad.{silenceMs,silenceThreshold,minSpeechMs}）
      const vadConfig = vadConfigFromSettings(settings)
      const r = await startVoiceRecording(this.kernel.dataDir, settings, process.env, {
        vad,
        ...(vadConfig ? { vadConfig } : {}),
        onVadEnded: () => { void this.finishVoiceRecording() },
      })
      if (!r.ok) {
        this.publish({ type: 'notification.show', payload: { text: `录音启动失败：${r.error}`, level: 'error' } })
        return { status: 'stopped', text: '' }
      }
      this.voiceRecordingSession = r.rec
      this.publish({ type: 'voice.status', payload: { state: 'listening' } })
      return { status: 'recording' }
    }

    // stop：结束采集 → whisper 本地转写 → 事件广播（前端自动注入 composer 提交）
    if (action === 'stop') {
      return this.finishVoiceRecording()
    }

    return { status: 'stopped', text: '' }
  }

  private commandsCatalog(): unknown {
    const categories = new Map<string, [string, string][]>()
    const canon: Record<string, string> = {}

    for (const cmd of SLASH) {
      const cat = COMMAND_CAT[cmd] ?? '◈'
      if (!categories.has(cat)) categories.set(cat, [])
      categories.get(cat)!.push([cmd, COMMAND_DESC[cmd] ?? ''])
      // 审计修复：canon 真实构建（此前恒空——slashHandler 别名解析永久失效）
      canon[cmd.replace(/^\//, '')] = cmd
    }

    // 技能计数真实统计（/help 展示技能数）
    let skillCount = 0
    try {
      skillCount = discoverSkills(this.kernel.dataDir, this.kernel.cwd).length
    } catch { /* 技能扫描失败按 0 */ }

    return {
      canon,
      categories: [...categories.entries()].map(([name, pairs]) => ({ name, pairs })),
      pairs: SLASH.map((cmd) => [cmd, COMMAND_DESC[cmd] ?? ''] as [string, string]),
      skill_count: skillCount,
      sub: {},
    }
  }

  // A8：技能名发现（/skill: 行内补全数据源；10s 缓存避免每次按键扫描目录）
  private skillNamesCache: { ts: number; names: string[] } | null = null

  private discoverSkillNames(): string[] {
    if (this.skillNamesCache && Date.now() - this.skillNamesCache.ts < 10_000) {
      return this.skillNamesCache.names
    }

    let names: string[] = []
    try {
      names = discoverSkills(this.kernel.dataDir, this.kernel.cwd).map(s => s.name)
    } catch {
      names = []
    }

    this.skillNamesCache = { ts: Date.now(), names }
    return names
  }

  private completeSlash(params: Record<string, unknown>): unknown {
    const text = String(params.text ?? '')
    const q = text.startsWith('/') ? text.slice(1).toLowerCase() : text.toLowerCase()

    // 接入层开放闭环：/model <前缀> → 目录 + 档案模型联合补全（选择器外的手打路径同享）
    const modelMatch = /^model\s+(.*)$/.exec(q)
    if (modelMatch) {
      const prefix = modelMatch[1]!.toLowerCase()
      const providers = (Array.isArray((this.kernel.settings as any).providers) ? (this.kernel.settings as any).providers : []) as Array<Record<string, any>>
      const catalogIds = MODEL_CATALOG.map(m => m.modelId).filter(id => id.toLowerCase().startsWith(prefix))
      const profileIds = providers.flatMap(p => (Array.isArray(p.models) ? p.models : [])).filter((id: string) => String(id).toLowerCase().startsWith(prefix))
      const items = [...new Set([...catalogIds, ...profileIds])].slice(0, 12)
      return { items: items.map(id => ({ display: id, meta: '模型', text: id, kind: 'slash' })), replace_from: 7 }
    }

    // /profile use <前缀> → 档案 id 补全
    const profileMatch = /^profile\s+use\s+(.*)$/.exec(q)
    if (profileMatch) {
      const prefix = profileMatch[1]!.toLowerCase()
      const providers = (Array.isArray((this.kernel.settings as any).providers) ? (this.kernel.settings as any).providers : []) as Array<Record<string, any>>
      const items = providers.map(p => String(p.id)).filter(id => id.toLowerCase().startsWith(prefix)).slice(0, 12)
      return { items: items.map(id => ({ display: id, meta: '档案', text: id, kind: 'slash' })), replace_from: 13 }
    }

    // A8：行内 /skill:<前缀> → 技能名补全（skillsOnly；参考 inlineSlashTrigger 同款）
    const skillMatch = /^skill:(.*)$/.exec(q)

    if (skillMatch) {
      const prefix = skillMatch[1]!.toLowerCase()
      const skills = this.discoverSkillNames()
        .filter((n) => n.toLowerCase().startsWith(prefix))
        .slice(0, 12)
      // 补全为 /skill:<名>（replace_from=1：从斜杠后替换）
      return {
        items: skills.map((n) => ({ display: `/skill:${n}`, meta: '技能', text: `/skill:${n}`, kind: 'slash' })),
        replace_from: 1,
      }
    }

    // 32 条 ≈ 2-3 页（建议面板窗口 16 行 + PgUp/PgDn 翻页浏览全部命令）
    const items = SLASH.filter((c) => c.slice(1).toLowerCase().startsWith(q)).slice(0, 32)
    const desc = (c: string) => COMMAND_DESC[c] ?? ''

    return {
      items: items.map((c) => ({ display: c, meta: desc(c), text: c, kind: 'slash' })),
      replace_from: 1,
    }
  }

  private async completePath(params: Record<string, unknown>): Promise<unknown> {
    const word = String(params.word ?? '')
    // @提及补全（Claude Code @mention 同款）：剥掉前导 @ 在 cwd 查文件，
    // 显示/回填保留 @ 前缀（接受补全后 token 仍为 @path，提交时展开内容）
    const isMention = word.startsWith('@')
    const raw = isMention ? word.slice(1) : word
    const dir = raw.includes('/') || raw.includes('\\') ? raw.slice(0, Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1) : ''
    const base = dir ? join(this.kernel.cwd, dir) : this.kernel.cwd
    const prefix = raw.slice(dir.length).toLowerCase()
    let entries: string[] = []

    try {
      entries = readdirSync(base)
        .filter((n) => !n.startsWith('.') && n.toLowerCase().startsWith(prefix))
        .slice(0, 12)
    } catch {
      entries = []
    }

    // 波 2 ②：@ 双源——纯名字前缀（无路径分隔符）时合入子代理类型（agent 源），
    // 与文件同榜分层排序（crush completions.go:205-260 对标：basename 精确>前缀>路径段）
    const agentItems = isMention && !raw.includes('/') && !raw.includes('\\')
      ? (await import('../kernel/subagentTypes.js')).SUBAGENT_KINDS
          .map((k) => ({ display: `@${k}`, meta: 'agent', text: `@${k}`, kind: 'agent' as const }))
          .filter((a) => a.display.toLowerCase().startsWith(`@${prefix}`))
      : []
    const fileItems = entries.map((n) => ({
      display: (isMention ? '@' : '') + dir + n,
      text: (isMention ? '@' : '') + dir + n,
      kind: 'path' as const,
    }))
    const ranked = (await import('../wxnodus-ui/lib/completionRank.js')).rankCompletions([...agentItems, ...fileItems], prefix)

    return {
      items: ranked.slice(0, 12),
      replace_from: params.replaceFrom ?? 0,
    }
  }

  // ── 状态栏余额监控（💰）：60s 防抖 + 内核 5 分钟 TTL；失败诚实 ⚠ ──
  private balanceCache: { value: unknown; ts: number } | null = null
  private lowBalanceNotified = false

  private async balanceStatus(params: Record<string, unknown>): Promise<unknown> {
    const bm = (this.kernel.settings as any)?.balanceMonitor ?? {};
    if (bm.enabled === false) return { ok: true, configured: false, enabled: false };
    if (!params.force && this.balanceCache && Date.now() - this.balanceCache.ts < 60_000) return this.balanceCache.value;
    const { resolveProviderProfile } = await import('../kernel/profiles.js')
    const { fetchBalanceCached } = await import('../kernel/balance.js')
    const rp = resolveProviderProfile(this.kernel.settings as Record<string, any>)
    if (!rp) return { ok: true, configured: false }
    const profile = { ...rp.profile, balanceUrl: (bm.url as string) || rp.profile.balanceUrl || '', balancePath: (bm.jsonPath as string) || rp.profile.balancePath || '' }
    if (!profile.balanceUrl) return { ok: true, configured: false, reason: 'no-balance-url' }
    const r = await fetchBalanceCached(profile, this.kernel.settings as Record<string, any>, { force: params.force === true })
    const value = r.ok
      ? { ok: true, configured: true, balance: r.info.balance, currency: r.info.currency, source: r.info.source, cached: r.cached, updated_at: Date.now() }
      : { ok: false, configured: true, error: r.error, updated_at: Date.now() }
    // 低余额预警（余额耗尽场景护栏）：低于阈值且未通知过 → sticky warn；回升重新武装；
    // 余额 ≤0 写入运行时态 balanceEmpty（agent 环 autoStop 硬停门控数据源——不落盘）；
    // low 标记随响应下发——状态栏 💰 段变红（一眼可见钱快没了）
    if (r.ok) {
      const { numericBalance: toNum, lowBalanceDecision, balanceStopDecision, LOW_BALANCE_THRESHOLD } = await import('../kernel/balance.js');
      const num = toNum(r.info);
      (this.kernel.settings as any).balanceEmpty = num !== null && num <= 0;
      const threshold = Number((bm as any).lowThreshold ?? LOW_BALANCE_THRESHOLD);
      const low = num !== null && num < threshold;
      if (low) (value as Record<string, unknown>).low = true;
      const d = lowBalanceDecision(num, threshold, this.lowBalanceNotified);
      this.lowBalanceNotified = d.armed;
      if (d.notify) {
        this.publish({ type: 'notification.show', payload: { kind: 'sticky', level: 'warn', text: `余额不足预警：当前 ${r.info.balance}${r.info.currency ? ` ${r.info.currency}` : ''}（阈值 ${threshold}——/balance refresh 复核）` } });
      }
      if (balanceStopDecision(num, (bm as any).autoStop === true)) {
        this.publish({ type: 'notification.show', payload: { kind: 'sticky', level: 'error', text: '余额已耗尽——auto-stop 已生效：后续对话将停止（充值后自动恢复，或 /balance auto-stop off）' } });
      }
    }
    this.balanceCache = { value, ts: Date.now() }
    return value
  }

  // ── 状态栏分区间 token（📊）：跨会话聚合（today/7d/30d）──
  private usageRange(_params: Record<string, unknown>): unknown {
    const range = ((this.kernel.settings as any)?.usageRange as string) || 'today'
    try {
      const s = this.kernel.adapter.data.usage.usageRange(range)
      return { range, ...s }
    } catch { return { range, input: 0, output: 0, total: 0, calls: 0, unmeasured: 0 } }
  }

  private usageRangeSet(params: Record<string, unknown>): unknown {
    const range = ['today', '7d', '30d'].includes(String(params.range ?? '')) ? String(params.range) : 'today'
    ;(this.kernel.settings as any).usageRange = range
    this.kernel.config.setKey('settings', 'usageRange', range)
    this.publish({ type: 'session.info', payload: this.buildInfo() })
    return this.usageRange({})
  }

  private modelOptions(params: Record<string, unknown>): unknown {
    const byProvider = new Map<string, any>()
    // 有密钥即视为已认证（无门禁）
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

    // 接入层开放闭环：档案（/profile）作为选择器中的独立 provider 分组——
    // 选中档案模型经 /model 直达（handlers.ts 命中档案 → 切 activeProvider + baseURL）
    const providers = (Array.isArray((this.kernel.settings as any).providers) ? (this.kernel.settings as any).providers : []) as Array<Record<string, any>>
    const activeProfile = (this.kernel.settings as any).activeProvider
    for (const p of providers) {
      const slug = `profile:${p.id}`
      byProvider.set(slug, {
        name: p.name ?? p.id,
        slug,
        models: Array.isArray(p.models) ? [...new Set(p.models as string[])] : [],
        authenticated: Boolean(p.key) || authenticated,
        auth_type: 'api_key',
        key_env: `WXNODUS_${String(p.id).toUpperCase()}_KEY`,
        ...(p.id === activeProfile ? { active: true } : {}),
      })
    }

    return {
      model: this.kernel.settings.model ?? '',
      providers: [...byProvider.values()].map((p) => ({
        ...p,
        models: [...new Set<string>(p.models)],
        // 初始定位：选择器打开即落在当前模型所在提供商（此前 RPC 从不设置 → 恒落第 0 项）
        is_current: [...new Set<string>(p.models)].includes(this.kernel.settings.model ?? ''),
        // 参考价目（USD/1M；未收录定价不显示——诚实不编）——成本敏感选型的显示数据
        prices: Object.fromEntries(
          [...new Set<string>(p.models)]
            .map(id => { const pr = priceForModel(id); return pr ? [id, pr] : null })
            .filter((x): x is [string, { in: number; out: number }] => x !== null)
        ),
      })),
      session_id: params.session_id ?? null,
    }
  }

  private modelSaveKey(params: Record<string, unknown>): unknown {
    // 兼容双契约：picker 传 { slug, api_key }，旧调用传 { key, base_url }
    const key = String(params.api_key ?? params.key ?? '')
    const baseURL = String(params.base_url ?? params.baseURL ?? '')
    const slug = String(params.slug ?? '')

    if (key) {
      // 单一写入路径（modelRegistry.applyModelKey）：档案 → 档案 key 槽；目录厂商 → apiKeys 归属槽
      const msg = slug.startsWith('profile:')
        ? applyModelKey(this.kernel.config as ModelRegistryPort, key, { profileId: slug.slice('profile:'.length) })
        : applyModelKey(this.kernel.config as ModelRegistryPort, key, slug ? { provider: slug } : {});
      if (msg.includes('档案不存在')) return { provider: null, error: msg };
      this.kernel.audit?.('model.set-key', { slug, source: 'picker' });
    }
    if (baseURL) {
      this.kernel.settings.baseURL = baseURL
      this.kernel.config.setKey('settings', 'baseURL', baseURL)
    }

    // picker 期待 { provider }（含 authenticated）——返回保存后的 provider
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

    // 档案 slug：重建档案分组（authenticated 按档案 key 槽——保存后立即反映）
    if (slug.startsWith('profile:')) {
      const id = slug.slice('profile:'.length)
      const providers = (Array.isArray((this.kernel.settings as any).providers) ? (this.kernel.settings as any).providers : []) as Array<Record<string, any>>
      const p = providers.find(x => x.id === id)
      if (p) {
        return {
          provider: {
            slug,
            name: p.name ?? id,
            models: Array.isArray(p.models) ? [...new Set(p.models as string[])] : [],
            authenticated: Boolean(p.key),
            auth_type: 'api_key',
            key_env: `WXNODUS_${String(id).toUpperCase()}_KEY`,
          },
        }
      }
    }

    return {
      provider: byProvider.get(slug) ?? { slug, authenticated: Boolean(key), models: [] },
    }
  }

  private modelDisconnect(params: Record<string, unknown>): unknown {
    const slug = String(params.slug ?? '')
    // 档案密钥：只清档案 key 槽（不动全局/其它厂商）
    if (slug.startsWith('profile:')) {
      const id = slug.slice('profile:'.length)
      const providers = (Array.isArray((this.kernel.settings as any).providers) ? (this.kernel.settings as any).providers : []) as Array<Record<string, any>>
      this.kernel.config.setKey('settings', 'providers', providers.map(p => (p.id === id ? { ...p, key: undefined } : p)))
      this.kernel.audit?.('model.disconnect', { slug, source: 'picker' })
      return { disconnected: true }
    }
    // 全局/目录厂商：清遗留单槽 + 归属槽
    this.kernel.settings.apiKeyEnc = ''
    this.kernel.config.setKey('settings', 'apiKeyEnc', '')
    if (slug) {
      const apiKeys = { ...((this.kernel.config.getKey('settings', 'apiKeys') as Record<string, string> | undefined) ?? {}) }
      delete apiKeys[slug]
      this.kernel.config.setKey('settings', 'apiKeys', apiKeys)
    }
    this.kernel.audit?.('model.disconnect', { slug: slug || 'global', source: 'picker' })
    return { disconnected: true }
  }

  /** 选择器「＋ 添加自定义接口」提交——model.add RPC（与 /model add 同一写入路径） */
  private modelAdd(params: Record<string, unknown>): unknown {
    const name = String(params.name ?? '').trim()
    const baseURL = String(params.base_url ?? params.baseURL ?? '').trim()
    const models = (Array.isArray(params.models)
      ? params.models.map(String).map(s => s.trim()).filter(Boolean)
      : String(params.models ?? '').split(',').map(s => s.trim()).filter(Boolean))
    const key = params.api_key ? String(params.api_key) : undefined
    if (!name || !/^https?:\/\//i.test(baseURL) || !models.length) {
      return { ok: false, error: '参数不完整：需要 name（非空）、base_url（http(s)://）、models（非空）' }
    }
    try {
      const r = addCustomModel(
        this.kernel.config as ModelRegistryPort,
        { modelIds: [...new Set(models)], baseURL, name, ...(key ? { key } : {}) },
        (event, payload) => this.kernel.audit?.(event, payload),
      )
      return {
        ok: true,
        id: r.id,
        message: r.message,
        provider: { slug: `profile:${r.id}`, name, models: [...new Set(models)], authenticated: Boolean(key) },
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
    }
  }

  // ── 审批桥：agent 工具确认 → approval.request 事件 → approval.respond RPC ──
  // 返回用户选择：'allow'（一次）/ 'session'（本会话）/ 'deny'（拒绝）——Kimi auto_approve_actions 同款
  requestApproval(name: string, args: Record<string, any>): Promise<'allow' | 'session' | 'deny'> {
    return new Promise((resolve) => {
      this.pendingApproval = { resolve: (choice: string) => resolve(choice === 'deny' ? 'deny' : choice === 'session' ? 'session' : 'allow') }
      const cls = classifyToolAction(name, args)
      // P1 脱敏：审批回显前对疑似凭据形状打码（sk-xxx/Bearer/JWT/KEY=值 等），
      // 防止命令中的密钥在审批面板/日志中明文出现（Hermes _redact_approval_command 同思路）
      const rawDescription = args?.question ? String(args.question) : name === 'bash' ? String(args?.command ?? '') : JSON.stringify(args ?? {}).slice(0, 300);
      const redacted = redactSecrets(rawDescription);
      if (redacted.hits.length) {
        this.publish({ type: 'notification.show', payload: { kind: 'ttl', level: 'warn', text: `审批内容已脱敏：${redacted.hits.length} 处疑似凭据（${[...new Set(redacted.hits.map(h => h.label))].join('、')}）` } });
      }
      this.publish({
        type: 'approval.request',
        payload: {
          command: name,
          description: redacted.text,
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
      // P3：working 窗口对齐——归档消息（黑洞 recall 层）不进会话视图
      const msgs = this.kernel.adapter.data.messages.load(sessionId)

      // A12：会话切换 timeline 事件（◈ 前缀，一次性注入列表头部）
      if (this.lastSessionEvent && this.lastSessionEvent.sid === sessionId && msgs.length) {
        const ev = this.lastSessionEvent
        this.lastSessionEvent = null
        return [{ role: 'system' as const, text: `◈ ${ev.text}` }, ...msgs]
      }

      return msgs
    } catch {
      return []
    }
  }

  private buildInfo(): SessionInfo {
    const s = this.kernel.settings

    // 审计修复：skills/tools/usage 从空对象改为真实数据（此前硬编码空——假数据）
    let skills: Record<string, string[]> = {}
    try {
      const names = discoverSkills(this.kernel.dataDir, this.kernel.cwd).map(s => s.name)
      skills = names.length ? { '可用技能': names.slice(0, 20) } : {}
    } catch { /* 技能扫描失败按空 */ }
    let tools: Record<string, string[]> = {}
    try {
      const names = Object.keys(coreTools())
      tools = names.length ? { '内置工具': names.slice(0, 30) } : {}
    } catch { /* 工具枚举失败按空 */ }
    let usage = { ...ZERO }
    try {
      const row = this.kernel.adapter.data.usage.get(this.currentSessionId)
      // A24 第三类修复：compressions 真实数据源——messages 表中压缩摘要行
      // （（自动压缩摘要）前缀，kernel compactSmart 每次压缩写入一条）计数
      let compressions = 0
      try {
        compressions = this.kernel.adapter.data.usage.compressions(this.currentSessionId)
      } catch { /* 压缩计数失败按零 */ }
      // 状态栏 $ 成本段（#11 尾项）：usage.get 已按模型聚合估算（全部模型有定价才给 cost_usd）
      if (row) usage = { calls: row.calls ?? 0, input: row.input ?? 0, output: row.output ?? 0, total: (row.input ?? 0) + (row.output ?? 0), compressions, ...(typeof row.cost_usd === 'number' ? { cost_usd: row.cost_usd } : {}) }
    } catch { /* 用量统计失败按零 */ }
    // A24 第三类修复：MCP 服务器真实状态（kernel mcpStatus——连接/工具数/传输方式）
    let mcp_servers: SessionInfo['mcp_servers']
    try {
      mcp_servers = (this.kernel.mcpStatus?.() ?? []).map(s => ({
        connected: s.connected,
        name: s.name,
        tools: s.tools,
        transport: s.transport,
      }))
    } catch { /* MCP 状态失败按空 */ }

    return {
      model: s.model ?? '',
      perm: String(s.mode ?? 'smart'),
      cwd: this.kernel.cwd,
      skills,
      tools,
      usage,
      mcp_servers,
      system_prompt: this.kernel.systemPrompt?.(),
      update_behind: this.kernel.updateBehind ?? null,
      version: WXNODUS_VERSION,
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
    this.kernel.adapter.agent.abort()
    this.running = false
    for (const off of this.unsubscribe) {
      try { off() } catch { /* 忽略 */ }
    }
    this.unsubscribe = []
  }
}
