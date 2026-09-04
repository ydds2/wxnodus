// src/tui/index.ts — WxNodus 自研 TUI 装配入口（2026-08-29 用户裁决：基于 wxn-tui-LIVE.html
// 原型制作，全自研——机制参考 kimi/crush/codex，代码与视觉原创；零 WS 零子进程，
// React 19 + 官方 ink 6 进程内渲染（框架裁决：成熟组件——废弃自研 fork 与行式核）。
import { render } from 'ink'
import { TuiStore } from './store.js'
import { TuiRuntime } from './runtime.js'
import { App } from './ui/App.js'
import { createPasteStdin } from './paste.js'
import { enableMouse, disableMouse } from './mouse.js'

export interface WxnodusTuiDeps {
  bus: { on(type: string, fn: (e: any) => void): () => void }
  agent: {
    run(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; text: string; turns: number; interrupted?: boolean }>
    abort(): void
    steer(text: string): boolean
  }
  commandBus: { execute(cmd: string, ctx?: unknown): Promise<unknown> }
  config: { get(path: string): Record<string, any> }
  /** 首启向导 locale（settings.lang 缺省时的 TUI 语言回退——批次ⅩⅩⅤ） */
  localeFallback?: string
  cwd: string
  gitBranch?: () => string | null
  /** 模型目录（原型 08 选择器——kernel MODEL_CATALOG 经 cli 注入） */
  modelCatalog?: () => Array<{ id: string; name: string; provider: string }>
  /** 设置窄写口（原型 31 主题改即存——settings 单一写路径；布尔项存布尔） */
  setSetting?: (key: string, value: string | boolean) => void
  /** 输入历史落盘路径（原型 29 持久化——G5） */
  historyFile?: () => string
  /** 上下文水位（原型 26/32——usage_stats SUM + maxContext，经 cli 窄端注入） */
  contextUsage?: () => { used: number; limit: number } | null
  /** 命令全景索引（原型 53——registry 单一事实来源经 cli 窄端注入） */
  commandIndex?: () => Array<{ cmd: string; desc: string; cat: string }>
  /** 端点探测（原型 58 测试连接——网络归 cli，TUI 零网络） */
  probeEndpoint?: (baseURL: string, apiKey: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>
  /** 会话用户消息时间线（原型 28 回滚面板——messages 表只读查询经 cli 窄端注入） */
  sessionMessages?: () => Array<{ runNo: number; ts: number; preview: string }>
  /** 「独立艺术品」品牌化（name/icon——ConfigService.resolveBranding 经 cli 窄端注入） */
  branding?: () => { name: string; icon: string | null } | null
  /** 当前会话 id（/resume 等命令切换会话后视图同步检测——经 cli 窄端注入） */
  sessionId?: () => string
  /** 当前会话最近转录（user/assistant——/resume 视图重建数据源；TUI 不直连 DB） */
  sessionTranscript?: () => Array<{ role: string; text: string }>
  /** 语音管线（原型 34——ffmpeg+whisper/SAPI 全链在 kernel，TUI 零媒体处理） */
  voice?: {
    available(): boolean
    start(): Promise<{ ok: boolean; error?: string }>
    stop(): Promise<{ ok: boolean; text?: string; error?: string }>
    cancel(): void
    speak(text: string): boolean
  }
  onRequestExit(): void
}

/** bridges 消费面（cli/index.ts let gateway 中介）——headlessGateway 同接口的进程内实现 */
export interface WxnodusTuiHandle {
  readonly store: TuiStore
  readonly runtime: TuiRuntime
  /** bridges 四面 */
  requestApproval(name: string, args: Record<string, unknown>): Promise<'allow' | 'session' | 'deny'>
  requestClarify(question: string, choices?: string[]): Promise<string>
  requestSecretInput(kind: 'sudo' | 'secret', prompt: string, name?: string): Promise<string | null>
  requestCredentialForm(): Promise<Record<string, string> | null>
  /** 生命周期 */
  start(): void
  kill(): void
  /** SIGINT 中断当前回合（cli 转发） */
  interrupt(): void
  readonly running: boolean
  /** /help 面板等外部触发 */
  toggleHelp(): void
  /** unmount（disposer） */
  unmount(): void
}

export function createWxnodusTui(deps: WxnodusTuiDeps): WxnodusTuiHandle {
  const store = new TuiStore()
  const runtime = new TuiRuntime({
    store,
    bus: deps.bus,
    agent: deps.agent,
    commandBus: deps.commandBus,
    config: deps.config,
    localeFallback: deps.localeFallback,
    cwd: deps.cwd,
    gitBranch: deps.gitBranch,
    modelCatalog: deps.modelCatalog,
    setSetting: deps.setSetting,
    historyFile: deps.historyFile,
    contextUsage: deps.contextUsage,
    commandIndex: deps.commandIndex,
    probeEndpoint: deps.probeEndpoint,
    sessionMessages: deps.sessionMessages,
    branding: deps.branding,
    sessionId: deps.sessionId,
    sessionTranscript: deps.sessionTranscript,
    voice: deps.voice,
    onRequestExit: deps.onRequestExit,
  })
  // T76 bracketed paste 协议级粘贴 + ⅩⅩⅩⅢ SGR 鼠标过滤（滚轮→转录视口滚动）
  // 鼠标 SGR 序列在 paste 流层剥离（不进 ink——此前透传导致乱码+输入框干扰）
  const paste = createPasteStdin(process.stdin, process.stdout, {
    onWheel: dir => {
      const snap = store.getSnapshot()
      if (snap.overlay.kind !== 'none') return // 浮层态不干扰
      if (dir === 'up') {
        // 滚轮上 = PgUp 语义：视口上滚（与 PgUp 同款步长——一屏）
        const cur = snap.scroll.pinnedLine ?? 99999
        store.setPinnedLine(Math.max(0, cur - 10))
      } else {
        store.scrollToBottom() // 滚轮下 = 贴底跟随
      }
    },
  })
  paste.enable()
  enableMouse(process.stdout) // ⅩⅩⅫ：鼠标支持（Windows Terminal/ConEmu）
  // ink 的 stdin 选项类型收窄为 ReadStream——Transform 已按 ink 契约补齐 isTTY/setRawMode/ref（见 paste.ts）
  const instance = render(<App store={store} runtime={runtime} />, { exitOnCtrlC: false, patchConsole: false, stdin: paste.stream as unknown as NodeJS.ReadStream })

  const handle: WxnodusTuiHandle = {
    store,
    runtime,
    requestApproval: (n, a) => runtime.requestApproval(n, a),
    requestClarify: (q, c) => runtime.requestClarify(q, c),
    requestSecretInput: (k, p, nm) => runtime.requestSecretInput(k, p, nm),
    requestCredentialForm: () => runtime.requestCredentialForm(),
    start: () => runtime.start(),
    kill: () => runtime.sigint(),
    interrupt: () => { runtime.esc() },
    get running() { return store.getSnapshot().running },
    toggleHelp: () => runtime.toggleHelp(),
    unmount: () => { runtime.dispose(); instance.unmount(); paste.disable(); paste.dispose(); disableMouse(process.stdout) },
  }
  return handle
}
