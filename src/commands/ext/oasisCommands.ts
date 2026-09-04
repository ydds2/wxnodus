// src/commands/ext/oasisCommands.ts — OASIS 统一运行时门户（2026-09-03 · M1）
// 计划书 docs/oasis-integration-assessment-2026-09-03.md 的第一里程碑：
//   /oasis status —— 全栈异构组件注册表视图（MCP 任意语言服务器/插件/会话/任务/后台终端/生态依赖/协议入口）
//   /oasis topo   —— 当前会话依赖拓扑（模型→MCP→插件→任务→记忆/审计）
// 原则：数据全部来自真实装配面（loadMcpConfig/getPlugins/term/db/probeEcosystem）；
//       未装配/未配置面诚实标注，绝不假装组件存在（wxnodus 诚实文化）。
import { lines } from '../outputFormat.js';
import type { HandlerCtx } from '../handlers.js';
import type { CommandBus } from '../../app/CommandBus.js';
import { langOf } from '../mcpStatus.js';

export function registerOasisCommands(bus: CommandBus, ctx: HandlerCtx): void {
  bus.register('/oasis', async (args) => {
    const sub = (args[0] ?? 'status').toLowerCase()
    const { loadMcpConfig } = await import('../../kernel/mcp.js')
    const mcp = (() => { try { return loadMcpConfig(ctx.dataDir, { cwd: ctx.cwd }) } catch { return [] } })()

    // ── M2：组件健康探针（2026-09-03）──
    // 对已注册 MCP 逐个真实 initialize 协商（stdio/streamable-http 双传输），
    // 报 era/协议版本/延迟；失败报真因——绝不把未连通的组件标在线（诚实文化）。
    if (sub === 'health') {
      const name = args[1]
      const targets = name ? mcp.filter((e: any) => e.name === name) : mcp
      if (!targets.length) {
        return name
          ? `server「${name}」未配置（/mcp add <名称> <命令> 先配置）`
          : lines(' OASIS 健康 ', [' 未配置 MCP server——/mcp add <名称> <命令> 接入任意语言组件后即可探活', ' 同步可查：插件/任务/终端在 /oasis status；生态依赖在 /eco'])
      }
      const { connectMcp } = await import('../../infrastructure/mcp/mcpClientHost.js')
      const { McpTransportPolicy } = await import('../../infrastructure/mcp/mcpTransportPolicy.js')
      const probe = targets.slice(0, 8)
      const rows: string[] = []
      let ok = 0
      for (const t of probe as any[]) {
        const started = Date.now()
        try {
          if (t.url) {
            // SSRF 先验（私网/loopback/DNS fail-closed——与 /mcp connect 同一策略）
            const { lookup } = await import('node:dns/promises')
            const policy = new McpTransportPolicy({ resolve: async (host: string) => (await lookup(host, { all: true })).map(r => r.address) })
            await policy.assertHttpTarget(new URL(t.url))
          }
          const config = t.url
            ? { transport: 'streamable-http' as const, url: t.url, headers: {} }
            : { transport: 'stdio' as const, command: t.command, args: t.args ?? [], env: {} }
          const connected = await connectMcp(config, AbortSignal.timeout(20_000))
          const ms = Date.now() - started
          rows.push(` ✓ [${langOf(t)}] ${t.name} — era ${connected.era} · 协议 ${connected.negotiatedVersion} · ${ms}ms`)
          ok++
          try { await connected.dispose() } catch { /* dispose 失败不改变探活结论 */ }
        } catch (cause) {
          rows.push(` ✗ [${langOf(t)}] ${t.name} — ${String((cause as Error)?.message ?? cause).slice(0, 120)}`)
        }
      }
      if (targets.length > 8) rows.push(` … 其余 ${targets.length - 8} 个未探测（单轮上限 8——/oasis health <名称> 单探）`)
      rows.push('', ` 在线 ${ok}/${Math.min(targets.length, 8)}——全部真实 initialize 协商（零假装）`)
      return lines(` OASIS 健康 `, rows)
    }
    const plugins = ctx.getPlugins?.() ?? []
    const terms = (() => { try { return ctx.term?.list?.() ?? [] } catch { return [] } })()
    const rows = (() => {
      try {
        return {
          sessions: ctx.db.prepare(`SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 5`).all() as Array<{ id: string; title: string | null; updated_at: number }>,
          tasks: ctx.db.prepare(`SELECT id, kind, status, tags FROM tasks ORDER BY id DESC LIMIT 5`).all() as Array<{ id: number; kind: string; status: string; tags: string }>,
          messages: (ctx.db.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number }).c,
        }
      } catch { return { sessions: [], tasks: [], messages: 0 } }
    })()
    const eco = await (async () => {
      try {
        // 生态探测可能耗时（首次真探测）——失败/异常不阻断门户视图
        const { probeEcosystem } = await import('../../application/ecosystemStatus.js')
        return probeEcosystem(ctx.dataDir)
      } catch { return [] }
    })()
    const ecoOk = eco.filter(e => e.available).length

    const sid = ctx.agent?.getSessionId?.() ?? 'default'
    const model = ctx.getModel?.() ?? ''
    const mode = ctx.getMode?.() ?? 'smart'

    if (sub === 'topo') {
      const mcpRows = mcp.length
        ? mcp.slice(0, 10).map((s: any, i: number, arr: any[]) => `   ${i === arr.length - 1 ? '└' : '├'}─ [${langOf(s)}] ${s.name}${s.source === 'project' ? ' [项目]' : ' [用户]'}`)
        : ['   └─（未配置——/mcp add <名称> <命令> 接入任意语言组件）']
      return lines(' OASIS 拓扑 ', [
        ` 会话 ${sid}（${rows.messages} 消息）`,
        `  ├─ 模型：${model || '未配置（/model set-key）'} · 模式 ${mode}`,
        `  ├─ MCP 服务器：${mcp.length} 个`,
        ...mcpRows,
        `  ├─ 插件：${plugins.length} 个`,
        `  ├─ 后台任务：${rows.tasks.length} 个 · 后台终端：${terms.length} 个`,
        `  └─ 记忆/审计：黑洞引擎（FTS5 + 向量）· 证据链 · 会话流`,
        '',
        ` 协议出口：--wire（JSONL 事件流）· --serve（HTTP 网关）· ACP（Zed/JetBrains）· A2A（智能体互通）· --mcp-server（对外提供工具）`,
      ])
    }

    if (sub !== 'status') return `用法：/oasis status（组件注册表）｜ /oasis health [名称]（真实探活）｜ /oasis topo（依赖拓扑）——OASIS 统一运行时门户（全栈异构组件在 wxnodus 内核中共存）`

    const mcpRows = mcp.length
      ? mcp.slice(0, 10).map((s: any) => `   [${langOf(s)}] ${s.name}${s.source === 'project' ? ' [项目]' : ' [用户]'} → ${s.url ? `HTTP ${s.url}` : `${s.command} ${(s.args ?? []).join(' ')}`}`)
      : ['   （未配置——/mcp add 接入任意语言组件；前端经 --wire/--serve，智能体经 A2A）']
    const pluginRows = plugins.length
      ? plugins.slice(0, 8).map((p: any) => `   ${p.name ?? p.id ?? '?'} · ${Object.keys(p.tools ?? {}).length} 工具 / ${Object.keys(p.commands ?? {}).length} 命令`)
      : ['   （未安装——/plugin install <目录>；组件化构建用 /forge）']
    const sessionRows = rows.sessions.length
      ? rows.sessions.map((s: any) => `   ${String(s.id).slice(0, 16)}  ${s.title || '(无标题)'}`)
      : ['   （暂无会话——/new 创建）']
    const taskRows = rows.tasks.length
      ? rows.tasks.map((t: any) => `   #${t.id} ${t.kind} ${t.status}${t.tags ? ` · ${t.tags}` : ''}`)
      : []
    const ecoFailRows = eco.filter(e => !e.available).slice(0, 6).map((e: any) => `   ✗ ${e.capability}（${e.channel}）— ${e.detail}`)

    return lines(' OASIS 统一运行时 ', [
      ` MCP 服务器 ${mcp.length} 个（任意语言组件——注册/发现/调用统一协议）`,
      ...mcpRows,
      ` 插件 ${plugins.length} 个（进程沙箱 · 命令/工具扩展）`,
      ...pluginRows,
      ` 会话 ${rows.sessions.length} 个（最近 5）`,
      ...sessionRows,
      ` 后台任务 ${rows.tasks.length} 个 · 后台终端 ${terms.length} 个 · 消息 ${rows.messages} 条`,
      ...taskRows,
      ` 生态依赖：${ecoOk}/${eco.length} 可用`,
      ...ecoFailRows,
      '',
      ` 协议入口：--wire（JSONL 事件流）· --serve（HTTP 网关）· ACP（Zed/JetBrains）· A2A（智能体互通）· --mcp-server（对外提供工具）`,
      ` 异构共存：不同技术栈组件零重写接入（MCP 标准协议）——/oasis topo 看依赖拓扑`,
    ])
  })
}
