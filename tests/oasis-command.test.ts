// tests/oasis-command.test.ts — OASIS 统一运行时门户（2026-09-03 · M1）命令契约
// 锁定：/oasis 三表注册；status 组件注册表视图（真实数据源 + 未装配诚实零）；topo 依赖拓扑。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandBus } from '../src/app/CommandBus.js'
import { createEventBus } from '../src/kernel/events.js'
import { openDB, closeDB } from '../src/store/db.js'
import { registerExtHandlers } from '../src/commands/handlersExt.js'
import { registerCoreHandlers } from '../src/commands/handlers.js'
import { SLASH, COMMAND_DESC, COMMAND_CAT } from '../src/commands/registry.js'

vi.mock('../src/application/ecosystemStatus.js', () => ({
  probeEcosystem: () => [
    { capability: 'whisper', channel: '语音', available: true, detail: '可用' },
    { capability: 'ocr', channel: '视觉', available: false, detail: '未安装（诚实降级）' },
  ],
}))

vi.mock('../src/infrastructure/mcp/mcpClientHost.js', () => ({
  connectMcp: vi.fn(async () => ({ era: '2024-11-05', negotiatedVersion: '2025-03-26', dispose: async () => {} })),
}))

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-oasis-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } dirs.length = 0 })

const baseCtx = (d: string) => ({
  dataDir: d, cwd: process.cwd(),
  db: openDB(d),
  bus: createEventBus(d),
  config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
  agent: { getSessionId: () => 'sA', run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
  getModel: () => '', getMode: () => 'smart',
}) as any

describe('/oasis 统一运行时门户', () => {
  it('registry 三表注册（SLASH/DESC/CAT 单一事实源）', () => {
    expect(SLASH).toContain('/oasis')
    expect(COMMAND_DESC['/oasis']).toContain('OASIS')
    expect(COMMAND_CAT['/oasis']).toBe('⛭')
  })

  it('status：空环境诚实零 + 组件注册表视图骨架（零假装）', async () => {
    const d = tmp()
    const bus = createCommandBus()
    const ctx = baseCtx(d)
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis status')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('OASIS 统一运行时')
    expect(r.output).toContain('MCP 服务器 0 个')
    expect(r.output).toContain('插件 0 个')
    expect(r.output).toContain('生态依赖：1/2 可用')
    expect(r.output).toContain('未安装（诚实降级）')
    expect(r.output).toContain('--mcp-server')
    closeDB(ctx.db)
  })

  it('status：真实数据源渲染（MCP 配置 + 插件 + 会话 + 后台终端）', async () => {
    const d = tmp()
    mkdirSync(join(d, 'user'), { recursive: true })
    writeFileSync(join(d, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'git-server': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'] },
        'py-helper': { command: 'uvx', args: ['helper-mcp'] },
      },
    }), 'utf8')
    const bus = createCommandBus()
    const ctx = {
      ...baseCtx(d),
      getPlugins: () => [{ name: 'demo-plugin', tools: { a: 1, b: 2 }, commands: { c: 3 } }],
      term: { list: () => [{ id: 't1' }] },
    }
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis status')
    expect(r.output).toContain('MCP 服务器 2 个')
    expect(r.output).toContain('[Node] git-server')
    expect(r.output).toContain('[Python] py-helper')
    expect(r.output).toContain('插件 1 个')
    expect(r.output).toContain('demo-plugin · 2 工具 / 1 命令')
    expect(r.output).toContain('后台终端 1 个')
    closeDB(ctx.db)
  })

  it('topo：依赖拓扑（模型/模式/MCP 树）', async () => {
    const d = tmp()
    writeFileSync(join(d, 'mcp.json'), JSON.stringify({
      mcpServers: { 'solo': { command: 'npx', args: ['solo-mcp'] } },
    }), 'utf8')
    const bus = createCommandBus()
    const ctx = baseCtx(d)
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis topo')
    expect(r.output).toContain('OASIS 拓扑')
    expect(r.output).toContain('会话 sA')
    expect(r.output).toContain('模型：未配置')
    expect(r.output).toContain('MCP 服务器：1 个')
    expect(r.output).toContain('[Node] solo')
    expect(r.output).toContain('黑洞引擎')
    closeDB(ctx.db)
  })

  it('未装配面 fail-closed（无 term/插件/探测异常均不崩）', async () => {
    const d = tmp()
    const bus = createCommandBus()
    const ctx = baseCtx(d)
    delete (ctx as any).term
    delete (ctx as any).getPlugins
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('插件 0 个')
    closeDB(ctx.db)
  })

  // ── M2：health 真实探活 ──
  it('health：全部在线（真实 initialize 协商 + era/版本/延迟）', async () => {
    const d = tmp()
    writeFileSync(join(d, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'git-server': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'] },
        'py-helper': { command: 'uvx', args: ['helper-mcp'] },
      },
    }), 'utf8')
    const bus = createCommandBus()
    const ctx = baseCtx(d)
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis health')
    expect(r.output).toContain('OASIS 健康')
    expect(r.output).toContain('✓ [Node] git-server')
    expect(r.output).toContain('✓ [Python] py-helper')
    expect(r.output).toContain('era 2024-11-05')
    expect(r.output).toContain('在线 2/2')
    closeDB(ctx.db)
  })

  it('health：部分失败报真因（绝不把未连通组件标在线）', async () => {
    const d = tmp()
    writeFileSync(join(d, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'ok-server': { command: 'npx', args: ['ok-mcp'] },
        'dead-server': { command: 'npx', args: ['dead-mcp'] },
      },
    }), 'utf8')
    const { connectMcp } = await import('../src/infrastructure/mcp/mcpClientHost.js')
    const mocked = vi.mocked(connectMcp)
    mocked.mockImplementation(async (config: any) => {
      if (config?.args?.[0] === 'dead-mcp') throw new Error('ECONNREFUSED（进程起不来）')
      // 局部桩：探活路径只用 era/negotiatedVersion/dispose——client/transport/discover 不参与（as any 对齐 vi.mocked 上下文签名）
      return { era: '2024-11-05', negotiatedVersion: '2025-03-26', dispose: async () => {} } as any
    })
    const bus = createCommandBus()
    const ctx = baseCtx(d)
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis health')
    expect(r.output).toContain('✓ [Node] ok-server')
    expect(r.output).toContain('✗ [Node] dead-server')
    expect(r.output).toContain('ECONNREFUSED')
    expect(r.output).toContain('在线 1/2')
    mocked.mockImplementation(async () => ({ era: '2024-11-05', negotiatedVersion: '2025-03-26', dispose: async () => {} } as any))
    closeDB(ctx.db)
  })

  it('health <名称>：单探过滤 + 未配置诚实报', async () => {
    const d = tmp()
    writeFileSync(join(d, 'mcp.json'), JSON.stringify({
      mcpServers: { 'solo': { command: 'npx', args: ['solo-mcp'] } },
    }), 'utf8')
    const bus = createCommandBus()
    const ctx = baseCtx(d)
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis health solo')
    expect(r.output).toContain('✓ [Node] solo')
    const missing = await bus.execute('/oasis health nope')
    expect(missing.output).toContain('未配置')
    closeDB(ctx.db)
  })

  it('health：HTTP 目标 SSRF 先验 fail-closed（loopback 拒绝，不假装连通）', async () => {
    const d = tmp()
    writeFileSync(join(d, 'mcp.json'), JSON.stringify({
      mcpServers: { 'evil': { url: 'http://127.0.0.1:9/x' } },
    }), 'utf8')
    const bus = createCommandBus()
    const ctx = baseCtx(d)
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute('/oasis health')
    expect(r.output).toContain('✗ [HTTP] evil')
    closeDB(ctx.db)
  })
})
