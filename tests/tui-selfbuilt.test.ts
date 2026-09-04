// tests/tui-selfbuilt.test.ts — 自研 TUI（src/tui）单元验证：store 语义 + runtime 降噪规则 + bridges 面
// 全自研 TUI 落地（2026-08-29）：本测试钉住核心行为，防回归。
import { describe, expect, it } from 'vitest'
import { TuiStore, initialTuiState } from '../src/tui/store.js'
import { TuiRuntime, clampOutput, toolSummary } from '../src/tui/runtime.js'
import { DEEP_SPACE, paletteOf, setTuiTheme } from '../src/tui/theme.js'
import { QUICK_COMMANDS, filterCommands, searchAllCommands, groupCommands, detectAttachments, touchCommand, resetCommandRecency } from '../src/tui/commands.js'

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
    expect(e[1]).toEqual({ kind: 'assistant', text: '你好', streaming: true })
  })

  it('并发命令输出不吞流：命令 assistant 条目后流式 token 开新条目（streaming 标记防串流）', () => {
    const s = new TuiStore()
    s.push({ kind: 'user', text: 'q' })
    s.appendStream('流式')
    s.push({ kind: 'assistant', text: '命令输出' }) // 并发命令输出（无 streaming 标记）
    s.appendStream('续流')
    expect(s.getSnapshot().entries.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['流式', '命令输出', '续流'])
  })

  it('sealStream 收口：新回合 token 不续写旧回合条目', () => {
    const s = new TuiStore()
    s.push({ kind: 'user', text: 'q1' })
    s.appendStream('第一回合')
    s.sealStream()
    s.push({ kind: 'user', text: 'q2' })
    s.appendStream('第二回合')
    expect(s.getSnapshot().entries.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['第一回合', '第二回合'])
  })

  it('子代理事件不落主转录：token/tool 按 session_id 过滤（A25 对齐——此前混入主面板）', async () => {
    const f = fakeDeps({ sessionId: () => 'main-s' })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.token', { text: '主回合', session_id: 'main-s' })
    f.emit('agent.token', { text: '子代理输出', session_id: 'main-s:sub1' })
    f.emit('agent.tool', { phase: 'start', name: 'bash', toolId: 't1', args: {}, session_id: 'main-s:sub1' })
    await new Promise(r => setTimeout(r, 80))
    const es = rt.store.getSnapshot().entries
    expect(es.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['主回合'])
    expect(es.some(e => e.kind === 'tool')).toBe(false)
    rt.dispose()
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

  it('/undo N 视图一致性：转录同步删除被回滚的用户轮次（命令回显不计入）', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    for (const t of ['q1', 'q2', 'q3']) {
      rt.store.push({ kind: 'user', text: t })
      rt.store.push({ kind: 'assistant', text: `a-${t}` })
    }
    await rt.submit('/undo 1')
    const entries = rt.store.getSnapshot().entries
    const users = entries.filter(e => e.kind === 'user')
    // q3 轮次被删：用户条目 = 欢迎之后的 q1、q2 + 命令回显（/undo 1 本身不算轮次）
    expect(users.map(u => u.text)).toEqual(['q1', 'q2', '/undo 1'])
    expect(entries.some(e => e.kind === 'assistant' && e.text === 'a-q3')).toBe(false)
    expect(entries.at(-1)?.kind).toBe('assistant') // 命令输出收尾
    // 回滚数超过轮次数：全部用户轮次清空（命令回显保留）
    await rt.submit('/undo 9')
    const after = rt.store.getSnapshot().entries
    expect(after.filter(e => e.kind === 'user').map(u => u.text)).toEqual(['/undo 9'])
  })

  it('/resume 视图一致性：会话切换即重建转录（命令回显 + 新会话历史 + 通知）', async () => {
    let sid = 's-aaaa'
    const f = fakeDeps({
      sessionId: () => sid,
      sessionTranscript: () => [
        { role: 'user', text: '旧问题' },
        { role: 'assistant', text: '旧回答' },
      ],
    })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.store.push({ kind: 'user', text: '当前会话的内容' })
    sid = 's-bbbb'
    await rt.submit('/resume s-bbbb')
    const entries = rt.store.getSnapshot().entries
    expect(entries.filter(e => e.kind === 'user').map(u => u.text)).toEqual(['/resume s-bbbb', '旧问题'])
    expect(entries.some(e => e.kind === 'assistant' && e.text === '旧回答')).toBe(true)
    expect(entries.some(e => e.kind === 'user' && e.text === '当前会话的内容')).toBe(false)
    const notice = entries.at(-1)
    expect(notice?.kind).toBe('notice')
    expect(notice?.text).toContain('视图已同步')
    expect(notice?.text).toContain('s-bbbb')
  })

  it('/checkpoint restore 视图一致性：同会话快照替换后重建转录', async () => {
    const f = fakeDeps({
      sessionId: () => 's-x',
      sessionTranscript: () => [
        { role: 'user', text: '恢复后的问题' },
        { role: 'assistant', text: '恢复后的回答' },
      ],
    })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.store.push({ kind: 'user', text: '快照前的内容' })
    rt.store.push({ kind: 'assistant', text: '旧回答' })
    await rt.submit('/checkpoint restore 3')
    const entries = rt.store.getSnapshot().entries
    expect(entries.filter(e => e.kind === 'user').map(u => u.text)).toEqual(['/checkpoint restore 3', '恢复后的问题'])
    expect(entries.some(e => e.kind === 'user' && e.text === '快照前的内容')).toBe(false)
    const notice = entries.at(-1)
    expect(notice?.kind).toBe('notice')
    expect(notice?.text).toContain('视图已同步')
    expect(notice?.text).toContain('2 条历史已加载')
  })

  it('失败命令按错误呈现：ok:false 走错误行 + 分类出路（此前误渲染为绿色助手行）', async () => {
    const f = fakeDeps()
    f.deps.commandBus.execute = async () => ({ ok: false, error: '未知命令：/zzz（/help 查看）', completionStatus: 'failed' })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/zzz')
    const last = rt.store.getSnapshot().entries.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.text).toContain('未知命令：/zzz')
    expect(last?.errorHint).toBeTruthy()
  })

  it('未配置密钥类失败：出路指向 /model 配置（config 分类）', async () => {
    const f = fakeDeps()
    f.deps.commandBus.execute = async () => ({ ok: false, output: '当前未配置模型密钥——/model set-key <密钥> 配置', completionStatus: 'blocked' })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/learn x')
    const last = rt.store.getSnapshot().entries.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.errorHint).toContain('/model')
  })

  it('/skill:name 注入链路：dispatch 正文作为消息发送（不再静默丢弃）', async () => {
    const f = fakeDeps()
    const sent: string[] = []
    const orig = f.deps.agent.run
    f.deps.agent.run = (p: string) => { sent.push(p); return orig(p) }
    f.deps.commandBus.execute = async () => ({ ok: true, output: '', dispatch: { kind: 'skill', name: 'demo', message: '技能正文内容' }, completionStatus: 'succeeded' })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/skill demo')
    expect(sent).toEqual(['技能正文内容'])
    const entries = rt.store.getSnapshot().entries
    expect(entries.some(e => e.kind === 'notice' && (e.text ?? '').includes('技能注入'))).toBe(true)
    expect(entries.some(e => e.kind === 'user' && e.text === '技能正文内容')).toBe(true)
  })

  it('命令执行心跳：长命令期间 command 非空（◈ 执行 数据源）· 收尾清空', async () => {
    const f = fakeDeps()
    let resolveExec: ((r: any) => void) | null = null
    f.deps.commandBus.execute = () => new Promise(res => { resolveExec = res })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const p = rt.submit('/build 做个待办系统')
    await new Promise(r => setTimeout(r, 20))
    const mid = rt.store.getSnapshot().command
    expect(mid?.text).toBe('/build 做个待办系统')
    resolveExec!({ ok: true, output: '完成' })
    await p
    expect(rt.store.getSnapshot().command).toBeNull()
  })

  it('Esc 中断命令等待：signal 中止 + 通知（长命令不再死等）', async () => {
    const f = fakeDeps()
    let gotSignal: { aborted: boolean } | null = null
    let resolveExec: ((r: any) => void) | null = null
    f.deps.commandBus.execute = (_cmd: string, ctx?: any) => {
      gotSignal = ctx?.signal ?? null
      return new Promise(res => { resolveExec = res })
    }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const p = rt.submit('/build 长任务')
    await new Promise(r => setTimeout(r, 20))
    expect(rt.store.getSnapshot().command?.text).toBe('/build 长任务')
    expect(rt.esc()).toBe(true) // 命令等待中断（Esc 即回）
    expect((gotSignal as { aborted: boolean } | null)?.aborted).toBe(true)
    expect(rt.store.getSnapshot().entries.at(-1)?.text).toContain('已中断命令等待')
    resolveExec!({ ok: true, output: '完成' })
    await p
    expect(rt.store.getSnapshot().command).toBeNull()
  })

  it('Esc 空闲态清空输入框（keys 面板承诺零漂移——此前为死键）', () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.store.setComposerValue('打了一半的字')
    expect(rt.esc()).toBe(true)
    expect(rt.store.getSnapshot().composer.value).toBe('')
    expect(rt.esc()).toBe(false) // 空输入无事可做
  })

  it('启动视图重建：自动恢复会话携带历史 → 转录直接展示（/resume 同口径——视图即真实）', () => {
    const f = fakeDeps({
      sessionId: () => 's-restored',
      sessionTranscript: () => [
        { role: 'user', text: '上次的问题' },
        { role: 'assistant', text: '上次的回答' },
      ],
    })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const es = rt.store.getSnapshot().entries
    expect(es[0]?.kind).toBe('notice') // 欢迎横幅
    expect(es[1]).toEqual({ kind: 'user', text: '上次的问题' })
    expect(es[2]).toEqual({ kind: 'assistant', text: '上次的回答' })
    expect(es.at(-1)?.kind).toBe('notice')
    expect(es.at(-1)?.text).toContain('已恢复会话 s-restor')
  })

  it('启动无历史：仅欢迎横幅（零空转）', () => {
    const f = fakeDeps({ sessionId: () => 's-empty', sessionTranscript: () => [] })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const es = rt.store.getSnapshot().entries
    expect(es).toHaveLength(1)
    expect(es[0]?.text).toContain('WxNodus 就绪')
  })

  it('agent.goal 事件：轮次分块（非一坨拼接）+ 轮次通知 + 完成通知', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.token', { text: '第1轮输出' })
    await new Promise(r => setTimeout(r, 80))
    f.emit('agent.goal', { round: 2, maxRounds: 10, done: false, text: '第1轮输出' })
    f.emit('agent.token', { text: '第2轮输出' })
    await new Promise(r => setTimeout(r, 80))
    f.emit('agent.goal', { round: 2, maxRounds: 10, done: true, text: '第2轮输出' })
    const es = rt.store.getSnapshot().entries
    expect(es.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['第1轮输出', '第2轮输出'])
    const notices = es.filter(e => e.kind === 'notice').map(e => e.text ?? '')
    expect(notices.some(t => t.includes('goal 第 1/10 轮完成'))).toBe(true)
    expect(notices.some(t => t.includes('goal 完成（2 轮）'))).toBe(true)
    rt.dispose()
  })

  it('goal 末轮去重：done 已落屏后 send 回传不再重复推全文', async () => {
    const f = fakeDeps()
    let runResolve: ((r: any) => void) | null = null
    f.deps.agent.run = () => new Promise(res => { runResolve = res })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.submit('做目标')
    await new Promise(r => setTimeout(r, 10))
    f.emit('agent.token', { text: '末轮输出' })
    await new Promise(r => setTimeout(r, 80)) // 冲刷
    f.emit('agent.goal', { round: 3, maxRounds: 10, done: true, text: '末轮输出' })
    runResolve!({ ok: true, text: '末轮输出', turns: 3 })
    await new Promise(r => setTimeout(r, 30))
    const assistants = rt.store.getSnapshot().entries.filter(e => e.kind === 'assistant')
    expect(assistants).toHaveLength(1) // 末轮全文不重复
    expect(assistants[0]!.text).toBe('末轮输出')
    rt.dispose()
  })

  it('cancelled 命令：notice 呈现（非错误——用户主动取消）', async () => {
    const f = fakeDeps()
    f.deps.commandBus.execute = async () => ({ ok: false, error: '命令已取消', completionStatus: 'cancelled' })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/build x')
    const last = rt.store.getSnapshot().entries.at(-1)
    expect(last?.kind).toBe('notice')
    expect(last?.text).toContain('已取消')
  })

  it('Esc 中断后队列暂留 2s：再按 Esc 清空（链条真正停住，不再自动续发）', async () => {
    const f = fakeDeps()
    const resolvers: Array<(r: any) => void> = []
    f.deps.agent.run = () => new Promise(res => { resolvers.push(res) })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.submit('第一条')
    await new Promise(r => setTimeout(r, 10))
    rt.submit('第二条')
    expect(rt.store.getSnapshot().queue).toEqual(['第二条'])
    rt.esc() // 第一按：中断 + 暂留
    expect(rt.store.getSnapshot().entries.at(-1)?.text).toContain('暂留')
    resolvers[0]!({ ok: true, text: '答1', turns: 1 })
    await new Promise(r => setTimeout(r, 30))
    expect(rt.store.getSnapshot().running).toBe(false) // 未自动续发（暂留挂起）
    rt.esc() // 第二按（2s 内）：清空
    const st = rt.store.getSnapshot()
    expect(st.queue).toHaveLength(0)
    expect(st.entries.at(-1)?.text).toContain('已清空 1 条排队消息')
    await new Promise(r => setTimeout(r, 2200)) // 越过恢复窗口
    expect(rt.store.getSnapshot().running).toBe(false)
    expect(rt.store.getSnapshot().entries.filter(e => e.kind === 'user' && e.text === '第二条')).toHaveLength(0)
    rt.dispose()
  })

  it('Esc 中断后队列暂留超时：自动续发（Esc 中断不丢的既有承诺保持）', async () => {
    const f = fakeDeps()
    const resolvers: Array<(r: any) => void> = []
    f.deps.agent.run = () => new Promise(res => { resolvers.push(res) })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.submit('第一条')
    await new Promise(r => setTimeout(r, 10))
    rt.submit('第二条')
    rt.esc()
    resolvers[0]!({ ok: true, text: '答1', turns: 1 })
    await new Promise(r => setTimeout(r, 30))
    expect(rt.store.getSnapshot().running).toBe(false)
    await new Promise(r => setTimeout(r, 2200)) // 窗口超时 → 续发
    const st = rt.store.getSnapshot()
    expect(st.running).toBe(true)
    expect(st.entries.some(e => e.kind === 'notice' && (e.text ?? '').includes('续发排队消息：第二条'))).toBe(true)
    resolvers[1]!({ ok: true, text: '答2', turns: 1 })
    await new Promise(r => setTimeout(r, 30))
    expect(rt.store.getSnapshot().running).toBe(false)
    rt.dispose()
  })

  it('bus 事件→转录：token 流（50ms 合批后落屏）/工具生命周期/notice', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.token', { text: '流式' })
    f.emit('agent.tool', { phase: 'start', name: 'bash', toolId: 't1', args: { command: 'ls' } })
    f.emit('agent.tool', { phase: 'complete', name: 'bash', toolId: 't1', ok: true, ms: 120 })
    f.emit('system.notice', { text: '规则放行' })
    await new Promise(r => setTimeout(r, 80)) // 合批窗口
    const es = rt.store.getSnapshot().entries
    const tool = es.find(e => e.kind === 'tool')
    expect(tool?.tool?.phase).toBe('done')
    expect(tool?.tool?.summary).toBe('ls')
    expect(es.some(e => e.kind === 'assistant' && e.text === '流式')).toBe(true)
    expect(es.some(e => e.kind === 'notice' && e.text === '规则放行')).toBe(true)
    rt.dispose()
  })

  it('token 合批（Live 限帧）：50ms 内多 token 合并为一次落屏', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    let renders = 0
    const off = rt.store.subscribe(() => renders++)
    f.emit('agent.token', { text: '你' })
    f.emit('agent.token', { text: '好' })
    f.emit('agent.token', { text: '世' })
    f.emit('agent.token', { text: '界' })
    await new Promise(r => setTimeout(r, 80))
    const es = rt.store.getSnapshot().entries
    expect(es.at(-1)?.kind).toBe('assistant')
    expect(es.at(-1)?.text).toBe('你好世界') // 合并完整不丢字
    expect(renders).toBeLessThan(5) // 合批——非逐 token 重渲染
    off()
    rt.dispose()
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
    resetCommandRecency()
    expect(QUICK_COMMANDS.length).toBeGreaterThanOrEqual(10)
    expect(filterCommands('/mod')).toEqual([QUICK_COMMANDS.find(c => c.cmd === '/model')!])
    expect(filterCommands('/zzz')).toHaveLength(0)
  })

  it('searchAllCommands：全目录无 24 截断（2026-09-03 用户裁决——空查询返回全部匹配，菜单滚动可达每一条）', () => {
    resetCommandRecency()
    const index = Array.from({ length: 30 }, (_, i) => ({ cmd: `/c${String(i).padStart(2, '0')}`, desc: `命令 ${i}`, cat: '◈' }))
    expect(searchAllCommands('', index)).toHaveLength(30)
    expect(searchAllCommands('/c0', index)).toHaveLength(10) // c00..c09 前缀命中全部返回
    expect(searchAllCommands('', QUICK_COMMANDS)).toHaveLength(QUICK_COMMANDS.length) // index 空回退高频目录
  })

  it('频序上浮：使用过的命令排前（kimi 按使用频次排序机制）', () => {
    resetCommandRecency()
    expect(filterCommands('/o')[0]!.cmd).toBe('/model') // 目录序基线（/o 命中多条，目录序首条 /model）
    touchCommand('/offline')
    expect(filterCommands('/o')[0]!.cmd).toBe('/offline') // 用过即上浮
    touchCommand('/model')
    expect(filterCommands('/o')[0]!.cmd).toBe('/model') // 后用的更前
    resetCommandRecency()
    expect(filterCommands('/o')[0]!.cmd).toBe('/model') // 重置后回目录序
  })

  it('submit 斜杠命令触碰频序（菜单随习惯自适应）', async () => {
    resetCommandRecency()
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/offline on')
    expect(filterCommands('/o')[0]!.cmd).toBe('/offline')
    resetCommandRecency()
  })
})

describe('输入历史与模型选择器（原型 08/29）', () => {
  it('Ctrl+↑↓ 历史召回：上一段/下一段循环，末段回空', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('第一条')
    await rt.submit('第二条')
    expect(rt.recallHistory(-1)).toBe('第二条')
    expect(rt.recallHistory(-1)).toBe('第一条')
    expect(rt.recallHistory(-1)).toBe('第一条') // 顶部钳制不越界
    expect(rt.recallHistory(1)).toBe('第二条')
    expect(rt.recallHistory(1)).toBe('') // 回到编辑态
  })

  it('裸 /model + 目录存在 → 打开选择器（原型 08 联动图谱）；带参走命令面', async () => {
    const f = fakeDeps({ modelCatalog: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek' }] })
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); return { ok: true, output: '' } } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/model')
    expect(rt.store.getSnapshot().overlay.kind).toBe('model')
    expect(executed).toHaveLength(0)
    rt.closeModelPicker()
    await rt.submit('/model glm-4-flash')
    expect(executed).toContain('/model glm-4-flash')
  })

  it('selectModel：关面板 → /model <id> 走命令面 → 状态回读', async () => {
    const f = fakeDeps({ modelCatalog: () => [{ id: 'glm-4-flash', name: 'GLM', provider: 'zhipu' }] })
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); return { ok: true, output: '已切换' } } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.openModelPicker()
    rt.selectModel('glm-4-flash')
    await new Promise(r => setTimeout(r, 10))
    expect(executed).toContain('/model glm-4-flash')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
  })

  it('转录滚动：setPinnedLine 顶锚定（负值钳 0）· scrollToBottom 恢复贴底跟随', () => {
    const s = new TuiStore()
    s.setPinnedLine(50)
    expect(s.getSnapshot().scroll.pinnedLine).toBe(50)
    s.setPinnedLine(-999)
    expect(s.getSnapshot().scroll.pinnedLine).toBe(0)
    s.setPinnedLine(20)
    s.scrollToBottom()
    expect(s.getSnapshot().scroll.pinnedLine).toBeNull()
  })
})

describe('编排/后台/模式/主题（原型 23/13/06/46/31/50）', () => {
  it('agent.subagent start→complete：编排块原位更新（同 id 复用——原型 23 状态点流转）', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.subagent', { goal: '架构审查', phase: 'start', subagent_id: 's1' })
    let block = rt.store.getSnapshot().entries.find(e => e.kind === 'agents')
    expect(block?.agents?.[0]?.phase).toBe('run')
    f.emit('agent.subagent', { goal: '架构审查', phase: 'complete', ok: true, turns: 3, subagent_id: 's1' })
    block = rt.store.getSnapshot().entries.find(e => e.kind === 'agents')
    expect(block?.agents).toHaveLength(1) // 同 id 复用，不新增行
    expect(block?.agents?.[0]?.phase).toBe('done')
    expect(block?.agents?.[0]?.turns).toBe(3)
    f.emit('agent.subagent', { goal: '测试覆盖', phase: 'start', subagent_id: 's2' })
    f.emit('agent.subagent', { goal: '测试覆盖', phase: 'complete', ok: false, subagent_id: 's2' })
    block = rt.store.getSnapshot().entries.find(e => e.kind === 'agents')
    expect(block?.agents).toHaveLength(2)
    expect(block?.agents?.[1]?.phase).toBe('fail')
  })

  it('jobs.created/complete：后台任务计数增减（原型 13 状态栏 ▣）', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('jobs.created', { id: 'j1', kind: 'bash', goal: 'npm test' })
    f.emit('jobs.created', { id: 'j2', kind: 'agent', goal: '文案优化' })
    expect(rt.store.getSnapshot().tasks).toHaveLength(2)
    f.emit('jobs.complete', { id: 'j1' })
    expect(rt.store.getSnapshot().tasks.map(t => t.id)).toEqual(['j2'])
    f.emit('jobs.complete', { id: 'j2' })
    expect(rt.store.getSnapshot().tasks).toHaveLength(0)
  })

  it('agent.stage：回合阶段入心跳行（原型 04）；endTurn 清空', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.stage', { stage: '正在验证 todo-cli 启动' })
    expect(rt.store.getSnapshot().stage).toContain('验证')
    rt.store.beginTurn()
    rt.store.endTurn()
    expect(rt.store.getSnapshot().stage).toBe('')
  })

  it('模式全部经 /perm 选择器进入（热键已移除）：/perm 命令面单一写路径', async () => {
    const modeBox = { mode: 'smart', model: 'm' } // 模拟 cli setMode 闭包：命令写 → config 即时回读
    const f = fakeDeps({ config: { get: () => ({ ...modeBox }) } })
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => {
      executed.push(c)
      const m = c.split(' ')[1]
      if (m) modeBox.mode = m
      return { ok: true, output: '' }
    } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/perm') // 裸 /perm → 打开选择器（不直接执行命令）
    expect(rt.store.getSnapshot().overlay.kind).toBe('mode')
    rt.selectMode('plan') // 选择器选择 → 唯一写路径 /perm <mode>
    await new Promise(r => setTimeout(r, 10))
    expect(executed).toContain('/perm plan')
    expect(rt.store.getSnapshot().mode).toBe('plan')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none') // 选择后自动关闭
    rt.openModePicker()
    rt.selectMode('yolo') // yolo 也经选择器显式进入（醒目警示由 applyMode 推送）
    await new Promise(r => setTimeout(r, 10))
    expect(executed).toContain('/perm yolo')
    expect(rt.store.getSnapshot().mode).toBe('yolo')
    // 带参 /perm <mode> 仍走命令面（不弹选择器）
    await rt.submit('/perm smart')
    await new Promise(r => setTimeout(r, 10))
    expect(executed).toContain('/perm smart')
  })

  it('裸 /theme → 选择器；selectTheme 改即存（setSetting 持久化 + 色板即换）', async () => {
    const saved: Array<[string, string]> = []
    const f = fakeDeps({ setSetting: (k: string, v: string) => { saved.push([k, v]) } })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/theme')
    expect(rt.store.getSnapshot().overlay.kind).toBe('theme')
    rt.selectTheme('dusk')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
    expect(rt.store.getSnapshot().themeName).toBe('dusk')
    expect(saved).toEqual([['tuiTheme', 'dusk']])
    expect(DEEP_SPACE.accent).toBe(paletteOf('dusk').accent)
    setTuiTheme('deepspace') // 复原全局（测试间不串色）
  })

  it('/clear：转录视图即清（会话保留提示）', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.store.push({ kind: 'notice', text: '旧内容' })
    await rt.submit('/clear')
    const st = rt.store.getSnapshot()
    expect(st.entries).toHaveLength(1)
    expect(st.entries[0]!.text).toContain('已清屏')
  })
})

// ── termcap：cmd 兼容三档（原型场景 55 可实现性的代码侧）──
import { detectTermTier, glyphsFor, type TermTier } from '../src/tui/termcap.js'

describe('termcap 终端分档', () => {
  it('Windows Terminal / ConEmu / CI → full（完整字形）', () => {
    expect(detectTermTier({ WT_SESSION: 'x' } as never)).toBe('full')
    expect(detectTermTier({ ConEmuANSI: 'ON' } as never)).toBe('full')
    expect(detectTermTier({ TERM: 'xterm-256color' } as never)).toBe('full')
  })

  it('C2 现代终端兼容扩展：WezTerm/Ghostty/TERM 前缀族/COLORTERM → full', () => {
    expect(detectTermTier({ WEZTERM_EXECUTABLE: 'wezterm.exe' } as never)).toBe('full')
    expect(detectTermTier({ GHOSTTY_RESOURCES_DIR: '/ghostty' } as never)).toBe('full')
    expect(detectTermTier({ TERM_PROGRAM: 'alacritty' } as never)).toBe('full')
    expect(detectTermTier({ TERM_PROGRAM: 'tabby' } as never)).toBe('full')
    expect(detectTermTier({ TERM: 'alacritty' } as never)).toBe('full')
    expect(detectTermTier({ TERM: 'xterm' } as never)).toBe('full')
    expect(detectTermTier({ COLORTERM: 'truecolor' } as never)).toBe('full')
    // 非 VT 信号不误判（dumb 终端/screen 保守 basic）
    expect(detectTermTier({ TERM: 'dumb' } as never)).toBe('basic')
    expect(detectTermTier({ COLORTERM: 'yes' } as never)).toBe('basic')
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

// ── 错误分类/确认桥/配置面板/表单/历史落盘（原型 12/46/59/58/29 · G2 部分/G5/G7/G8）──
import { classifyError } from '../src/tui/runtime.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('错误分类 → 出路提示（原型 12 部分落地）', () => {
  it('网络/超时类 → 换模型/转离线出路', () => {
    const r = classifyError('MODEL_TIMEOUT：上游 60s 无响应')
    expect(r.kind).toBe('network')
    expect(r.hint).toContain('/offline on')
  })

  it('循环检测类 → 回退/压缩出路（无 LLM 提炼——机械关键词）', () => {
    const r = classifyError('检测到工具调用循环（相同调用重复 8 次），终止')
    expect(r.kind).toBe('loop')
    expect(r.hint).toContain('/undo')
  })

  it('配额类 → 余额/免费档出路', () => {
    expect(classifyError('deepseek 余额不足 ¥0.12').kind).toBe('quota')
  })

  it('未知类 → 自检兜底（诚实不猜）', () => {
    const r = classifyError('某奇怪错误 XYZ')
    expect(r.kind).toBe('unknown')
    expect(r.hint).toContain('/doctor')
  })
})

describe('确认桥/配置面板/表单/历史落盘（原型 46/59/58/29）', () => {
  it('requestConfirm：默认选否 · resolve yes/no · 危险橙色', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const p = rt.requestConfirm('切换 yolo？', { danger: true })
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('confirm')
    if (ov.kind === 'confirm') {
      expect(ov.pending.selected).toBe(1) // 默认否（防手滑——crush quit.go 同族）
      expect(ov.pending.danger).toBe(true)
      ov.pending.resolve('yes')
    }
    await expect(p).resolves.toBe('yes')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
  })

  it('selectMode：选择器唯一写路径——yolo 显式选择直达 /perm + 醒目警示（2026-09-03 用户裁决：热键已移除）', async () => {
    const modeBox = { mode: 'smart', model: 'm' }
    const f = fakeDeps({ config: { get: () => ({ ...modeBox }) } })
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); const m = c.split(' ')[1]; if (m) modeBox.mode = m; return { ok: true, output: '' } } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.openModePicker()
    expect(rt.store.getSnapshot().overlay.kind).toBe('mode')
    rt.selectMode('yolo')
    await new Promise(r => setTimeout(r, 10))
    expect(executed).toContain('/perm yolo')
    expect(rt.store.getSnapshot().mode).toBe('yolo')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none') // 选择后自动关闭
    // yolo 进入有醒目警示（用户必须知道站在全放行档）
    const notices = rt.store.getSnapshot().entries.filter(e => e.kind === 'notice').map(e => e.text).join('\n')
    expect(notices).toContain('⚠ 模式：yolo')
    // 非危险档同样经选择器改即存
    rt.openModePicker()
    rt.selectMode('plan')
    await new Promise(r => setTimeout(r, 10))
    expect(executed).toContain('/perm plan')
  })

  it('toggleThinking/toggleLang：setSetting 窄写口（改即存——布尔项存布尔，非字符串）', () => {
    const saved: Array<[string, string | boolean]> = []
    const f = fakeDeps({ setSetting: (k: string, v: string | boolean) => { saved.push([k, v]) }, config: { get: () => ({ thinking: true, lang: 'zh-CN' }) } })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.toggleThinking()
    expect(saved).toEqual([['thinking', false]]) // 布尔口径（e2e 真机测试捕获的开关不可逆缺陷修复）
    rt.toggleLang()
    expect(saved).toContainEqual(['lang', 'en'])
  })

  it('submitModelForm：三字段 → /model add 命令面（https 校验 + 空名校验）', async () => {
    const f = fakeDeps()
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); return { ok: true, output: '已添加' } } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.openModelForm()
    rt.submitModelForm({ name: 'my kimi', baseURL: 'https://api.example.com/v1', key: 'sk-123' })
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
    expect(executed[0]).toBe('/model add my-kimi --base https://api.example.com/v1 --key sk-123')
    // 非法 baseURL：面板不关 + 错误行带出路
    rt.openModelForm()
    rt.submitModelForm({ name: 'x', baseURL: 'http://insecure', key: '' })
    expect(rt.store.getSnapshot().overlay.kind).toBe('modelform')
    const err = rt.store.getSnapshot().entries.at(-1)
    expect(err?.kind).toBe('error')
    expect(err?.errorHint).toContain('https://api.example.com')
  })

  it('输入历史落盘：提交防抖写文件 · 新实例跨会话召回（G5）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-tui-hist-'))
    const file = join(dir, 'tui-history.json')
    try {
      const f = fakeDeps({ historyFile: () => file })
      const rt = new TuiRuntime(f.deps)
      rt.start()
      await rt.submit('跨会话召回测试')
      await new Promise(r => setTimeout(r, 700)) // 防抖窗口
      expect(existsSync(file)).toBe(true)
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { items: string[] }
      expect(onDisk.items).toContain('跨会话召回测试')
      // 新实例（同文件）：loadHistory 后 Ctrl+↑ 召回
      const rt2 = new TuiRuntime(f.deps)
      rt2.start()
      expect(rt2.recallHistory(-1)).toBe('跨会话召回测试')
      rt.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('agent.error 事件 → 错误行带分类出路（原型 12 结构化呈现）', () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.error', { message: 'MODEL_TIMEOUT 上游无响应' })
    const err = rt.store.getSnapshot().entries.at(-1)
    expect(err?.kind).toBe('error')
    expect(err?.errorHint).toContain('/offline on')
  })
})

describe('上下文水位与全景索引（原型 26/32/53）', () => {
  it('refreshContext：启动/回合结束/心跳三触点（窄端注入 sanitize）', async () => {
    const box = { used: 0, limit: 64000 }
    const f = fakeDeps({ contextUsage: () => ({ used: box.used, limit: box.limit }) })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    expect(rt.store.getSnapshot().context).toEqual({ used: 0, limit: 64000 })
    box.used = 21400
    await rt.submit('计算一下')
    await new Promise(r => setTimeout(r, 30))
    expect(rt.store.getSnapshot().context?.used).toBe(21400) // 回合结束收口
    rt.refreshContext()
    expect(rt.store.getSnapshot().context?.used).toBe(21400)
  })

  it('refreshContext：依赖缺失 → null（不假装有数据）', () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    expect(rt.store.getSnapshot().context).toBeNull()
  })

  it('groupCommands：稳定分组 + 未知符号收归「其他」组尾（无孤儿命令自证——原型 53）', () => {
    const index = [
      { cmd: '/help', desc: '查看帮助', cat: '◈' },
      { cmd: '/model', desc: '模型', cat: '⚙' },
      { cmd: '/calc', desc: '计算', cat: '☆' },
      { cmd: '/mystery', desc: '未登记', cat: '?' },
      { cmd: '/undo', desc: '撤销', cat: '◈' },
    ]
    const groups = groupCommands(index)
    expect(groups[0]).toEqual({ label: '对话', items: [index[0], index[4]] })
    expect(groups.map(g => g.label).at(-1)).toBe('其他') // 组尾收归
    const flat = groups.flatMap(g => g.items)
    expect(flat).toHaveLength(5) // 无孤儿
    expect(groupCommands([])).toEqual([])
  })

  it('commandIndex 窄端透传', () => {
    const f = fakeDeps({ commandIndex: () => [{ cmd: '/x', desc: 'd', cat: '◈' }] })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    expect(rt.commandIndex()).toEqual([{ cmd: '/x', desc: 'd', cat: '◈' }])
    const none = new TuiRuntime(fakeDeps().deps)
    expect(none.commandIndex()).toEqual([])
  })
})

describe('附件引用与快捷键速查（原型 33 部分/30）', () => {
  it('detectAttachments：@img/x.png 与 @path 引用去重 · 最多 4 个（防刷屏）', () => {
    expect(detectAttachments('看看 @img/error.png 和 @docs/说明.md 的问题')).toEqual(['img/error.png', 'docs/说明.md'])
    expect(detectAttachments('@a.png @a.png @b.png')).toEqual(['a.png', 'b.png'])
    expect(detectAttachments('@1.png @2.png @3.png @4.png @5.png @6.png')).toHaveLength(4)
    expect(detectAttachments('无附件文本')).toEqual([])
  })

  it('/keys → 速查面板（KEY_SECTIONS 单一事实来源）· Esc 关闭', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/keys')
    expect(rt.store.getSnapshot().overlay.kind).toBe('keys')
    rt.closeKeysPanel()
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
  })
})

describe('重连进度（原型 12 · G2 部分——agent.retry 结构化事件）', () => {
  it('agent.retry → 心跳倒计时数据；token(reset) → 重连成功退场', () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.retry', { attempt: 1, max: 3, delayMs: 800, message: 'ETIMEDOUT' })
    expect(rt.store.getSnapshot().retry?.attempt).toBe(1)
    expect(rt.store.getSnapshot().retry?.max).toBe(3)
    expect(rt.store.getSnapshot().retry?.delayMs).toBe(800)
    f.emit('agent.token', { text: '', reset: true })
    expect(rt.store.getSnapshot().retry).toBeNull()
  })

  it('N4 回归：子代理 retry/reset/error 不落主面板（跨会话过滤——kernel 事件已带 session_id）', async () => {
    const sid = 'n4-main'
    const f = fakeDeps({ sessionId: () => sid })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    // 主会话当前内容（供对照：不应被子代理事件破坏）
    f.emit('agent.token', { text: '主回合输出', session_id: sid })
    await new Promise(r => setTimeout(r, 80))
    // 子代理（异 session_id）重试：不产生主面板重连心跳
    f.emit('agent.retry', { attempt: 1, max: 3, delayMs: 800, session_id: 'sub-xyz', message: '子代理重连' })
    expect(rt.store.getSnapshot().retry).toBeNull()
    // 子代理 reset：不清空主回合当前 attempt（此前 dropCurrentAttempt 误伤主面板）
    f.emit('agent.token', { text: '', reset: true, session_id: 'sub-xyz' })
    const es = rt.store.getSnapshot().entries
    expect(es.some(e => e.kind === 'assistant' && (e.text ?? '').includes('主回合输出'))).toBe(true)
    expect(es.some(e => e.kind === 'notice' && (e.text ?? '').includes('已清空'))).toBe(false)
    // 子代理 error：不落主转录
    f.emit('agent.error', { message: '子代理失败', session_id: 'sub-xyz', code: 'PROVIDER_TRANSIENT', retries: 1 })
    expect(rt.store.getSnapshot().entries.some(e => e.kind === 'error' && (e.text ?? '').includes('子代理失败'))).toBe(false)
    // 对照：主会话 retry/error 仍正常呈现
    f.emit('agent.retry', { attempt: 2, max: 3, delayMs: 500, session_id: sid })
    expect(rt.store.getSnapshot().retry?.attempt).toBe(2)
    f.emit('agent.error', { message: '主回合失败', session_id: sid, code: 'PROVIDER_TRANSIENT', retries: 1 })
    expect(rt.store.getSnapshot().entries.some(e => e.kind === 'error' && (e.text ?? '').includes('主回合失败'))).toBe(true)
    rt.dispose()
  })

  it('重试流重置：失败尝试半截输出被清空（kernel reset 契约——杜绝「半截旧文+完整新文」拼接）', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.store.push({ kind: 'user', text: '问题' })
    f.emit('agent.token', { text: '失败尝试的半截' })
    await new Promise(r => setTimeout(r, 80))
    f.emit('agent.tool', { phase: 'start', name: 'bash', toolId: 't1', args: {} })
    f.emit('agent.token', { text: '', reset: true })
    f.emit('agent.token', { text: '重试完整输出' })
    await new Promise(r => setTimeout(r, 80))
    const es = rt.store.getSnapshot().entries
    expect(es.filter(e => e.kind === 'assistant').map(e => e.text)).toEqual(['重试完整输出'])
    expect(es.some(e => e.kind === 'tool')).toBe(false) // 失败尝试的工具行一并清空（重试会重新执行）
    expect(es.some(e => e.kind === 'notice' && (e.text ?? '').includes('已清空'))).toBe(true)
    rt.dispose()
  })

  it('agent.retry 第 2/3 次更新 + endTurn 清空', () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.retry', { attempt: 2, max: 3, delayMs: 1600 })
    expect(rt.store.getSnapshot().retry?.attempt).toBe(2)
    rt.store.beginTurn()
    rt.store.endTurn()
    expect(rt.store.getSnapshot().retry).toBeNull()
  })

  it('agent.error 带 retries 结构 → 出路追加「已自动重试 N 次仍失败」（诚实）', () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    f.emit('agent.error', { message: 'ETIMEDOUT 上游无响应', code: 'PROVIDER_TRANSIENT', retries: 3 })
    const err = rt.store.getSnapshot().entries.at(-1)
    expect(err?.kind).toBe('error')
    expect(err?.errorHint).toContain('已自动重试 3 次仍失败')
    expect(err?.errorHint).toContain('/offline on')
  })
})

describe('端点探测与 contextLimit（原型 58 完成/59 · G7/G9 销项）', () => {
  it('probeEndpoint 透传：接入成功回传模型列表；未接入诚实降级', async () => {
    const f = fakeDeps({ probeEndpoint: async () => ({ ok: true, models: ['m1', 'm2'] }) })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await expect(rt.probeEndpoint('https://x/v1', 'sk-1')).resolves.toEqual({ ok: true, models: ['m1', 'm2'] })
    const bare = new TuiRuntime(fakeDeps().deps)
    const r = await bare.probeEndpoint('https://x/v1', '')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未接入')
  })

  it('setContextLimit：8k 步进钳制（8k..256k）+ setSetting 持久化', () => {
    const saved: Array<[string, string]> = []
    const f = fakeDeps({ setSetting: (k: string, v: string) => { saved.push([k, v]) } })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.setContextLimit(24_576) // 非 8k 对齐 → 24k
    expect(saved).toEqual([['contextLimit', '24576']])
    rt.setContextLimit(10) // 下限钳制
    expect(saved.at(-1)).toEqual(['contextLimit', '8192'])
    rt.setContextLimit(999_999) // 上限钳制
    expect(saved.at(-1)).toEqual(['contextLimit', '262144'])
  })

  it('send：settings.contextLimit → agent.run 传 maxContextTokens（G9 真实消费——非法值零传递）', async () => {
    const captured: Array<{ maxContextTokens?: number }> = []
    const f = fakeDeps({
      config: { get: () => ({ mode: 'smart', model: 'm', contextLimit: '65536' }) },
    })
    f.deps.agent.run = async (_p: string, o?: { maxContextTokens?: number }) => {
      captured.push(o ?? {})
      return { ok: true, text: '', turns: 0 }
    }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('测试')
    await new Promise(r => setTimeout(r, 30))
    expect(captured[0]?.maxContextTokens).toBe(65536)
    // 非法值（< 4096）→ 零传递（内核按模型目录派生）
    const f2 = fakeDeps({ config: { get: () => ({ mode: 'smart', model: 'm', contextLimit: '100' }) } })
    const captured2: Array<{ maxContextTokens?: number }> = []
    f2.deps.agent.run = async (_p: string, o?: { maxContextTokens?: number }) => {
      captured2.push(o ?? {})
      return { ok: true, text: '', turns: 0 }
    }
    const rt2 = new TuiRuntime(f2.deps)
    rt2.start()
    await rt2.submit('测试2')
    await new Promise(r => setTimeout(r, 30))
    expect(captured2[0]?.maxContextTokens).toBeUndefined()
  })
})

describe('压缩三选桥（原型 32 · G10）', () => {
  it('requestCompactChoice：三选项面板 → resolve full/none/micro', async () => {
    const f = fakeDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const p = rt.requestCompactChoice({ used: 55_000, ctxLimit: 64_000, compactAt: 0.85 })
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('compact')
    if (ov.kind === 'compact') {
      expect(ov.pending.choices.map(c => c.key)).toEqual(['micro', 'full', 'none'])
      expect(ov.pending.selected).toBe(0) // micro 推荐
      ov.pending.resolve('full')
    }
    await expect(p).resolves.toBe('full')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none')
  })

  it('send：onCompactChoice 注入 agent.run——内核回调打开面板（桥通路验证）', async () => {
    const captured: Array<{ onCompactChoice?: (info: { used: number }) => Promise<string> }> = []
    const f = fakeDeps()
    let rtRef: TuiRuntime | null = null
    f.deps.agent.run = async (_p: string, o?: { onCompactChoice?: (info: { used: number }) => Promise<string> }) => {
      captured.push(o ?? {})
      // 模拟内核超阈值回调：桥打开面板，用户在面板上选择 micro
      if (o?.onCompactChoice) {
        const choiceP = o.onCompactChoice({ used: 60_000 })
        const ov = rtRef!.store.getSnapshot().overlay
        if (ov.kind === 'compact') ov.pending.resolve('micro')
        await choiceP
      }
      return { ok: true, text: '', turns: 0 }
    }
    const rt = new TuiRuntime(f.deps)
    rtRef = rt
    rt.start()
    await rt.submit('长任务')
    await new Promise(r => setTimeout(r, 40))
    expect(captured[0]?.onCompactChoice).toBeTypeOf('function')
    expect(rt.store.getSnapshot().overlay.kind).toBe('none') // 选择后关面板（决断必回主）
  })
})

describe('回滚时间线（原型 28 · G11 销项——/undo 命令面 + 面板）', () => {
  it('裸 /rewind 与 /undo → 回滚面板；sessionMessages 窄端透传', async () => {
    const f = fakeDeps({ sessionMessages: () => [{ runNo: 2, ts: Date.now(), preview: '第二条' }, { runNo: 1, ts: Date.now() - 1000, preview: '第一条' }] })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/rewind')
    expect(rt.store.getSnapshot().overlay.kind).toBe('rewind')
    expect(rt.sessionMessages()).toHaveLength(2)
    rt.closeRewindPanel()
    await rt.submit('/undo')
    expect(rt.store.getSnapshot().overlay.kind).toBe('rewind')
  })

  it('requestUndo：二次确认（危险橙）→ yes 走 /undo N 命令面 · no 零副作用', async () => {
    const f = fakeDeps()
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); return { ok: true, output: '已回滚' } } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.openRewindPanel()
    rt.requestUndo(2, { messages: 2 })
    await new Promise(r => setTimeout(r, 10))
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('confirm')
    if (ov.kind === 'confirm') ov.pending.resolve('no')
    await new Promise(r => setTimeout(r, 10))
    expect(executed).toHaveLength(0) // 取消零副作用
    rt.requestUndo(2, { messages: 2 })
    await new Promise(r => setTimeout(r, 10))
    const ov2 = rt.store.getSnapshot().overlay
    if (ov2.kind === 'confirm') ov2.pending.resolve('yes')
    await new Promise(r => setTimeout(r, 20))
    expect(executed).toContain('/undo 2')
  })
})

describe('计划提案批准流（原型 06 · G1 销项）', () => {
  function planDeps(runs: Array<{ ok: boolean; text: string }>) {
    const modeBox = { mode: 'plan', model: 'm' }
    const executed: string[] = []
    const prompts: string[] = []
    const f = fakeDeps({ config: { get: () => ({ ...modeBox }) } })
    f.deps.agent.run = async (p: string) => { prompts.push(p); const r = runs.shift(); return r ?? { ok: true, text: '', turns: 0 } }
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); const m = c.split(' ')[1]; if (m) modeBox.mode = m; return { ok: true, output: '已切换' } } }
    return { f, executed, prompts, modeBox }
  }

  it('批准：切回 smart + 以计划上下文执行（「按上述计划」指令重发）', async () => {
    const { f, executed, prompts, modeBox } = planDeps([{ ok: true, text: '计划：1 盘点 2 迁移' }, { ok: true, text: '执行完成' }])
    const rt = new TuiRuntime(f.deps)
    rt.start()
    const sendP = rt.submit('重构状态管理')
    await new Promise(r => setTimeout(r, 30))
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('plan') // 提案面板
    if (ov.kind === 'plan') ov.pending.resolve('approve')
    await new Promise(r => setTimeout(r, 60))
    expect(executed).toContain('/perm smart')
    expect(modeBox.mode).toBe('smart')
    expect(prompts).toContain('按上述计划开始执行（已批准）')
    await sendP
  })

  it('编辑：E → 编辑面板 → 以修改后的计划执行', async () => {
    const { f, prompts } = planDeps([{ ok: true, text: '计划 A' }, { ok: true, text: '按修改执行完成' }])
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.submit('任务')
    await new Promise(r => setTimeout(r, 30))
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('plan')
    if (ov.kind === 'plan') ov.pending.resolve('edit')
    await new Promise(r => setTimeout(r, 10))
    const ov2 = rt.store.getSnapshot().overlay
    expect(ov2.kind).toBe('planedit')
    if (ov2.kind === 'planedit') ov2.pending.resolve('修改后的计划：先做 B 再做 A')
    await new Promise(r => setTimeout(r, 60))
    expect(prompts).toContain('修改后的计划：先做 B 再做 A')
  })

  it('返回：计划保留不执行（诚实提示重发路径）', async () => {
    const { f, prompts } = planDeps([{ ok: true, text: '计划 X' }])
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.submit('任务')
    await new Promise(r => setTimeout(r, 30))
    const ov = rt.store.getSnapshot().overlay
    expect(ov.kind).toBe('plan')
    if (ov.kind === 'plan') ov.pending.resolve('cancel')
    await new Promise(r => setTimeout(r, 40))
    expect(prompts).toHaveLength(1) // 无第二次执行
    const last = rt.store.getSnapshot().entries.at(-1)
    expect(last?.text).toContain('计划保留')
  })
})

describe('语音对话（原型 34 · G6 部分销项）', () => {
  function voiceDeps(opts: { available?: boolean; startOk?: boolean; stopText?: string; stopError?: string } = {}) {
    const calls: string[] = []
    const spoken: string[] = []
    const f = fakeDeps({
      voice: {
        available: () => opts.available ?? true,
        start: async () => { calls.push('start'); return opts.startOk === false ? { ok: false, error: '设备占用' } : { ok: true } },
        stop: async () => { calls.push('stop'); return opts.stopError ? { ok: false, error: opts.stopError } : { ok: true, text: opts.stopText ?? '帮我把记忆整理成待办' } },
        cancel: () => { calls.push('cancel') },
        speak: (t: string) => { spoken.push(t); return true },
      },
    })
    return { f, calls, spoken }
  }

  it('录音 → 转写 → 入输入框（用户确认后发送——转写不进模型上下文）', async () => {
    const { f } = voiceDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.toggleVoiceRecording()
    expect(rt.store.getSnapshot().voice.state).toBe('recording')
    expect(rt.store.getSnapshot().overlay.kind).toBe('voice')
    await rt.stopVoiceAndTranscribe()
    const st = rt.store.getSnapshot()
    expect(st.voice.state).toBe('off')
    expect(st.overlay.kind).toBe('none')
    expect(st.composer.value).toBe('帮我把记忆整理成待办')
    expect(st.entries.at(-1)?.text).toContain('转写完成')
    rt.dispose()
  })

  it('Esc 取消：零残留（cancel + 提示）', async () => {
    const { f, calls } = voiceDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.toggleVoiceRecording()
    rt.cancelVoice()
    expect(calls).toContain('cancel')
    expect(rt.store.getSnapshot().voice.state).toBe('off')
    expect(rt.store.getSnapshot().entries.at(-1)?.text).toContain('零残留')
    rt.dispose()
  })

  it('设备不可用/启动失败：诚实降级不假装', async () => {
    const { f } = voiceDeps({ available: false })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.toggleVoiceRecording()
    const err = rt.store.getSnapshot().entries.at(-1)
    expect(err?.kind).toBe('error')
    expect(err?.text).toContain('语音不可用')
    const f2 = voiceDeps({ startOk: false })
    const rt2 = new TuiRuntime(f2.f.deps)
    rt2.start()
    await rt2.toggleVoiceRecording()
    expect(rt2.store.getSnapshot().entries.at(-1)?.text).toContain('录音启动失败')
    rt.dispose(); rt2.dispose()
  })

  it('自动播报：默认关零调用 · voiceAutoSpeak=true 只读摘要（不读代码）', () => {
    const { f, spoken } = voiceDeps()
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.maybeSpeak('很长的回答\n```code```\n更多内容')
    expect(spoken).toHaveLength(0) // 默认关（免打扰）
    const f2 = voiceDeps()
    f2.f.deps.config = { get: () => ({ voiceAutoSpeak: true }) } as any
    const rt2 = new TuiRuntime(f2.f.deps)
    rt2.start()
    rt2.maybeSpeak('第一行摘要\n第二行\n```ts\nconst x = 1\n```')
    expect(f2.spoken).toHaveLength(1)
    expect(f2.spoken[0]).not.toContain('```') // 不读代码
    expect(f2.spoken[0]).toContain('第一行摘要')
    rt.dispose(); rt2.dispose()
  })

  it('toggleVoiceSpeak：setSetting 持久化（配置面板 voice 行——布尔口径）', () => {
    const saved: Array<[string, string | boolean]> = []
    const f = fakeDeps({ setSetting: (k: string, v: string | boolean) => { saved.push([k, v]) }, config: { get: () => ({}) } })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.toggleVoiceSpeak()
    expect(saved).toEqual([['voiceAutoSpeak', true]])
    rt.dispose()
  })

  it('/paste → /img clipboard 命令面（剪贴板截图附件通道——单一写路径）', async () => {
    const f = fakeDeps()
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); return { ok: true, output: '分析完成' } } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    await rt.submit('/paste')
    expect(executed).toContain('/img clipboard')
    rt.dispose()
  })
})

describe('自完善批次（Esc 中断/合批落屏//new 视图一致性/审批倒计时）', () => {
  it('esc 运行中 → agent.abort（占位符广告的「Esc 中断」必须真实）', () => {
    const f = fakeDeps()
    let aborted = 0
    f.deps.agent.abort = () => { aborted++ }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.store.patch({ running: true })
    const handled = rt.esc()
    expect(handled).toBe(true)
    expect(aborted).toBe(1)
    rt.dispose()
  })

  it('/new：命令面执行 + 转录视图清空 + 水位刷新（会话切换视图一致性）', async () => {
    const f = fakeDeps({ contextUsage: () => ({ used: 100, limit: 64000 }) })
    const executed: string[] = []
    f.deps.commandBus = { execute: async (c: string) => { executed.push(c); return { ok: true, output: '会话 s123 已创建' } } }
    const rt = new TuiRuntime(f.deps)
    rt.start()
    rt.store.push({ kind: 'user', text: '旧会话内容' })
    await rt.submit('/new')
    await new Promise(r => setTimeout(r, 20)) // newSession 异步收口
    expect(executed).toContain('/new')
    const st = rt.store.getSnapshot()
    expect(st.entries).toHaveLength(1) // 旧转录清空，仅剩新会话通知
    expect(st.entries[0]!.text).toContain('新会话')
    expect(st.entries[0]!.text).toContain('s123')
    expect(st.context?.used).toBe(100) // 水位已刷新
    rt.dispose()
  })

  it('requestApproval：deadline 设定（倒计时数据源——原型 05）', () => {
    const f = fakeDeps({ approvalTimeoutMs: 120_000 })
    const rt = new TuiRuntime(f.deps)
    rt.start()
    void rt.requestApproval('bash', { command: 'ls' })
    const ov = rt.store.getSnapshot().overlay
    if (ov.kind === 'approval') {
      expect(ov.pending.deadline).toBeGreaterThan(Date.now() + 110_000)
      expect(ov.pending.deadline).toBeLessThan(Date.now() + 121_000)
    } else {
      expect.unreachable('审批浮层未打开')
    }
    rt.dispose()
  })
})
