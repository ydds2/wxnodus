// src/tui/index.ts — WxNodus 自研 TUI 装配入口（2026-08-29 用户裁决：基于 wxn-tui-LIVE.html
// 原型制作，全自研——机制参考 kimi/crush/codex，代码与视觉原创；零 WS 零子进程，
// React+@wxnodus/ink 进程内渲染；react 19.2.7+reconciler 0.33 钉死矩阵）。
import { render } from 'ink'
import { TuiStore } from './store.js'
import { TuiRuntime } from './runtime.js'
import { App } from './ui/App.js'

export interface WxnodusTuiDeps {
  bus: { on(type: string, fn: (e: any) => void): () => void }
  agent: {
    run(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; text: string; turns: number; interrupted?: boolean }>
    abort(): void
    steer(text: string): boolean
  }
  commandBus: { execute(cmd: string, ctx?: unknown): Promise<unknown> }
  config: { get(path: string): Record<string, any> }
  cwd: string
  gitBranch?: () => string | null
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
    cwd: deps.cwd,
    gitBranch: deps.gitBranch,
    onRequestExit: deps.onRequestExit,
  })
  const instance = render(<App store={store} runtime={runtime} />, { exitOnCtrlC: false, patchConsole: false })

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
    unmount: () => { runtime.dispose(); instance.unmount() },
  }
  return handle
}
