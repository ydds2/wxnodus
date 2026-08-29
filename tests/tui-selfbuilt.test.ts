// tests/tui-selfbuilt.test.ts — 自研 TUI（src/tui）单元验证：store 语义 + runtime 降噪规则 + bridges 面
// 全自研 TUI 落地（2026-08-29）：本测试钉住核心行为，防回归。
import { describe, expect, it } from 'vitest'
import { TuiStore, initialTuiState } from '../src/tui/store.js'
import { TuiRuntime, clampOutput, toolSummary } from '../src/tui/runtime.js'
import { DEEP_SPACE } from '../src/tui/theme.js'
import { QUICK_COMMANDS, filterCommands } from '../src/tui/ui/Composer.js'

function fakeDeps(over: Record<string, unknown> = {}) {
  const events: Array<{ type: string; payload: any }> = []
  const handlers = new Map<string, (e: any) => void>()
  const emit = (type: string, payload: any) => handlers.get(type)?.({ payload })
  void emit
  return {
    events,
    emit,
    deps: {
      store: new TuiStore(),
      bus: { on: (type: string, fn: (e: any) => void) => { handlers.set(type, fn); return () => handlers.delete(type) } },
      agent: {
        run: async () => ({ ok: true, text: '回答', turns: 1 }),
        abort() {}, steer: () => true,
      },
      commandBus: { execute: async () => ({ ok: true, output: '命令输出' }) },
      config: { get: () => ({ mode: 'smart', model: 'deepseek-chat' }) },
      cwd: 'C:/proj',
      gitBranch: () => 'master',
      onRequestExit: () => {},
      ...over,
    } as any,
  }
}

describe('TuiStore 语义', () => {
  it('初始态 + patch/push/subscribe', () => {
    const s = new TuiStore()
    expect(s.getSnapshot().running).toBe(false)
    let notified = 0
    const off = s.subscribe(() => notified++)
    s.push({ kind: 'user', text: 'hi' })
    expect(s.getSnapshot().entries).toHaveLength(1)
    expect(notified).toBe(1)
    off()
  })

  it('appendStream 只动最后一条 assistant（kimi 已确认块落屏模式）', () => {
    const s = new TuiStore()
    s.push({ kind: 'user', text: 'q' })
    s.appendStream('你')
    s.appendStream('好')
    const e = s.getSnapshot().entries
    expect(e).toHaveLength(2)
    expect(e[1]).toEqual({ kind: 'assistant', text: '你好' })
  })

  it('转录超限折叠最旧段（+N 条计数）', () => {
    const s = new TuiStore()
    for (let i = 0; i < 450; i++) s.push({ kind: 'notice', text: `n${i}` })
    const entries = s.getSnapshot().entries
    expect(entries.length).toBeLessThanOrEqual(401)
    expect(entries[0]?.kind).toBe('fold')
  })

  it('beginTurn/endTurn：thinking 收成单行 + 队列出队 pendingSend', () => {
    const s = new TuiStore()
    s.patch({ queue: ['下一条'] })
    s.beginTurn()
    expect(s.getSnapshot().running).toBe(true)
    s.patch({ thinkingMs: 2300, thinkingToks: 120 })
    s.endTurn()
    const st = s.getSnapshot()
    expect(st.running).toBe(false)
    expect(st.entries.at(-1)?.text).toContain('Thought for 2s')
    expect(s.pendingSend).toBe('下一条')
    expect(st.queue).toHaveLength(0)
  })
})

describe('降噪规则（原型 54 实证版）', () => {
  it('规则 1：工具摘要取 1 个关键参数（command > path > query > pattern）', () => {
    expect(toolSummary('bash', { command: 'npm test' })).toBe('npm test')
    expect(toolSummary('fs_edit', { path: 'src/a.ts' })).toBe('src/a.ts')
    expect(toolSummary('grep', { pattern: 'useEffect' })).toBe('useEffect')
    expect(toolSummary('http_get', {})).toBe('')
  })

  it('规则 3/4：head5+tail5 + 精确计数省略行', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}`)
    const out = clampOutput(lines.join('\n'))
    expect(out).toContain('+20 lines')
    expect(out.split('\n')).toHaveLength(11)
    expect(out.startsWith('L0')).toBe(true)
    expect(out.endsWith('L29')).toBe(true)
    const short = clampOutput('a\nb\nc')
    expect(short).toBe('a\nb\nc')
  })

  it('spinner 四相圆（cmd 全档安全——无 braille）', () => {
    expect(DEEP_SPACE.spinnerFrames).toEqual(['◐', '◓', '◑', '◒'])
  })
})

describe('TuiRuntime：bridges 面 + 双通道', () => {
  it('requestApproval → overlay 弹出 → 选择回传', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const p = rt.requestApproval('bash', { command: 'rm -rf dist' })
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('approval')
    if (ov.kind === 'approval') {
      expect(ov.pending.command).toBe('rm -rf dist')
      expect(ov.pending.choices).toHaveLength(4)
      ov.pending.resolve('session')
    }
    await expect(p).resolves.toBe('session')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
  })

  it('requestClarify：选项面 + 自由文本 resolve', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    const p = rt.requestClarify('选哪个？', ['a', 'b'])
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('clarify')
    if (ov.kind === 'clarify') ov.pending.resolve('b')
    await expect(p).resolves.toBe('b')
  })

  it('requestSecretInput：掩码面 + null 取消语义', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    const p1 = rt.requestSecretInput('secret', '密钥', 'K')
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind === 'secret' && ov.pending.masked === '').toBe(true)
    if (ov.kind === 'secret') ov.pending.resolve(null)
    await expect(p1).resolves.toBeNull()
  })

  it('运行中 submit 走排队（Enter 排队通道）', async () => {
    const f = fakeDeps()
    let resolving: ((r: any) => void) | null = null
    f.deps.agent.run = () => new Promise(res => { resolving = res })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.submit('第一条')
    await new Promise(r => setTimeout(r, 10))
    expect(rt.store.getSnapshot().running).toBe(true)
    rt.submit('排队的')
    expect(rt.store.getSnapshot().queue).toEqual(['排队的'])
    resolving!({ ok: true, text: '答', turns: 1 })
    await new Promise(r => setTimeout(r, 30))
    // 队列自动续发：running 再次为 true（第二条在跑）
    expect(rt.store.getSnapshot().running).toBe(true)
    resolving!({ ok: true, text: '答2', turns: 1 })
    await new Promise(r => setTimeout(r, 30))
    expect(rt.store.getSnapshot().running).toBe(false)
  })

  it('斜杠命令走 commandBus + /help 开合', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/doctor')
    const last = rt.store.getSnapshot().entries.at(-1)
    expect(last?.kind).toBe('assistant')
    rt.toggleHelp()
    expect(rt.store.getSnapshot().overlay.kind).toBe('help')
    rt.toggleHelp()
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
  })

  it('bus 事件→转录：token 流/工具生命周期/notice', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.token', { text: '流式' })
    f.emit('agent.tool', { phase: 'start', name: 'bash', toolId: 't1', args: { command: 'ls' } })
    f.emit('agent.tool', { phase: 'complete', name: 'bash', toolId: 't1', ok: true, ms: 120 })
    f.emit('system.notice', { text: '规则放行' })
    const es = rt.store.getSnapshot().entries
    const tool = es.find(e => e.kind === 'tool')
    expect(tool?.tool?.phase).toBe('done')
    expect(tool?.tool?.summary).toBe('ls')
    expect(es.some(e => e.kind === 'assistant' && e.text === '流式')).toBe(true)
    expect(es.some(e => e.kind === 'notice' && e.text === '规则放行')).toBe(true)
  })

  it('退出保护：运行中 Ctrl+C 先中断不退出', async () => {
    const f = fakeDeps()
    let exited = 0
    f.deps.onRequestExit = () => { exited++ }
    let resolving: ((r: any) => void) | null = null
    f.deps.agent.run = () => new Promise(res => { resolving = res })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.submit('长任务')
    await new Promise(r => setTimeout(r, 10))
    rt.sigint()
    expect(exited).toBe(0)
    resolving!({ ok: true, text: '', turns: 1 })
    await new Promise(r => setTimeout(r, 20))
    rt.sigint()  // 空闲首按：提示
    expect(exited).toBe(0)
    rt.sigint()  // 二按（exiting 窗口内）
    expect(exited).toBe(1)
  })
})

describe('斜杠命令菜单', () => {
  it('高频目录非空且过滤正确', () => {
    expect(QUICK_COMMANDS.length).toBeGreaterThanOrEqual(10)
    expect(filterCommands('/mod')).toEqual([QUICK_COMMANDS.find(c => c.cmd === '/model')!])
    expect(filterCommands('/zzz')).toHaveLength(0)
  })
})

// ── termcap：cmd 兼容三档（原型场景 55 可实现性的代码侧）──
import { detectTermTier, glyphsFor, type TermTier } from '../src/tui/termcap.js'

describe('termcap 终端分档', () => {
  it('Windows Terminal / ConEmu / CI → full（完整字形）', () => {
    expect(detectTermTier({ WT_SESSION: 'x' } as never)).toBe('full')
    expect(detectTermTier({ ConEmuANSI: 'ON' } as never)).toBe('full')
    expect(detectTermTier({ CI: '1', TERM: 'xterm-256color' } as never)).toBe('full')
  })

  it('裸 cmd（无信号）→ basic：豆腐高危字符（▎❯▏◐◷）零出现', () => {
    expect(detectTermTier({} as never)).toBe('basic')
    const g = glyphsFor('basic' as TermTier)
    const all = [g.bar, g.prompt, g.caret, g.pointer, g.running, g.queued, ...g.spinner]
    expect(all.some(c => /[▎❯▏◐◓◑◒◷▸•]/.test(c))).toBe(false)
  })

  it('三档 spinner：full 四相圆 / basic+ascii 经典转轮', () => {
    expect(glyphsFor('full').spinner).toEqual(['◐', '◓', '◑', '◒'])
    const classic = ['-', String.fromCharCode(92), '|', '/']
    expect(glyphsFor('basic').spinner).toEqual(classic)
    expect(glyphsFor('ascii').spinner).toEqual(classic)
  })

  it('强制覆盖：WXNODUS_TUI_TERM=full/ascii', () => {
    expect(detectTermTier({ WXNODUS_TUI_TERM: 'full' } as never)).toBe('full')
    expect(detectTermTier({ WT_SESSION: 'x', WXNODUS_TUI_TERM: 'ascii' } as never)).toBe('ascii')
  })
})
