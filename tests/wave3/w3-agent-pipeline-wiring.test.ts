// tests/wave3/w3-agent-pipeline-wiring.test.ts — C3 契约：agent 全工具经生产 11-port pipeline 执行
// 审批权威在 agent 前置链；pipeline 强制复核 PDP、grant/budget、effect-journal、evidence 与 postcondition。
// 一次性审批桥绑定 invocationId + canonical argsHash，动态工具使用显式 name → ToolId 映射。
// fail-closed 全锁定：未标记/拒绝 → POLICY_DENIED 零副作用；超预算 → BUDGET_EXCEEDED；未知 id → TOOL_NOT_FOUND。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical } from '../../src/domain/security/approvalGrant.js';
import { ok } from '../../src/protocol/results.js';
import { closeDB, openDB } from '../../src/store/db.js';
import { createEventBus } from '../../src/kernel/events.js';
import { createMemory } from '../../src/kernel/memory.js';
import { createAgent } from '../../src/kernel/agent.js';
import { coreTools, type ToolCtx, type ToolDef } from '../../src/kernel/tools.js';
import { mcpClientsToTools, type McpClient } from '../../src/kernel/mcp.js';
import { loadPlugin, pluginToolsToExtra } from '../../src/kernel/plugins.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import { createProductionToolExecution, type ToolExecutionWiringOptions } from '../../src/application/tools/toolExecutionWiring.js';
import { createAgentToolSurface, createAgentApprovalBridge } from '../../src/application/tools/agentToolSurface.js';
import type { PolicyDocument } from '../../src/domain/security/pdp.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';
import { createRunContext } from '../../src/protocol/runs.js';

const policyDoc: PolicyDocument = {
  version: 1,
  hardRedlineKinds: [],
  rules: [
    { effectKind: 'memory.read', action: 'allow' },
    { effectKind: 'filesystem.read', action: 'allow' },
    { effectKind: 'filesystem.write', action: 'require_approval' },
    { effectKind: 'network.request', action: 'require_approval' },
    { effectKind: 'process.spawn', action: 'require_approval' },
    { effectKind: 'memory.write', action: 'require_approval' },
    { effectKind: 'config.write', action: 'require_approval' },
    { effectKind: 'extension.manage', action: 'require_approval' },
    { effectKind: 'ui.external', action: 'require_approval' },
  ],
};

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

function fixture(overrides: Partial<ToolExecutionWiringOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w3-agent-pipeline-'));
  const db = openDB(dir);
  const memoryRepository = openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
  cleanup.push(() => { try { closeDB(db); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  const bridge = createAgentApprovalBridge();
  const pipeline = createProductionToolExecution({
    db, dataDir: dir, workspaceRoot: dir, memoryRepository,
    policy: { id: 'policy-1', document: policyDoc },
    budget: { id: 'budget-1', limits: { externalWrites: 1, networkRequests: 1, processSpawns: 1 } },
    approver: request => Promise.resolve(String(request.toolId).startsWith('agent:') ? bridge.consume(request.invocationId, request.argsHash) : true),
    ...overrides,
  });
  const agentTool = createAgentToolSurface({ tools: coreTools() });
  const registered = pipeline.registerAgentTools(agentTool.surface);
  if (!registered.ok) throw new Error(registered.error.code);
  const rawRunner = agentTool.attach(pipeline.pipeline, bridge);
  const runContext = () => createRunContext({
    runId: 'r1', correlationId: 'parent-corr', sessionId: 's1', actorId: 'actor:test', source: 'cli',
  });
  const runner = {
    handles: rawRunner.handles,
    execute: (name: string, args: Record<string, any>, ctx: ToolCtx, context = runContext()) => rawRunner.execute(name, args, ctx, context),
  };
  const toolCtx = (over: Partial<ToolCtx> = {}): ToolCtx => ({
    cwd: dir, dataDir: dir, sessionId: 's1', db, bus: createEventBus(dir),
    ask: async () => true, clarify: async () => '', ...over,
  });
  let seq = 0;
  const context = (): OperationContext => ({
    actorId: 'actor:test', sessionId: 's1', runId: 'r1', correlationId: `corr-${++seq}`,
    policySnapshotId: 'unused（authorize 以仓储活动快照为可信源）', locale: 'zh-CN', source: 'cli',
    capabilities: [], timestamp: '2026-08-13T00:00:00.000Z',
  });
  return { dir, db, pipeline, bridge, agentTool, runner, toolCtx, context };
}

const evidenceCount = (dir: string): number => readdirSync(join(dir, 'evidence', 'tools')).filter(f => f.endsWith('.json')).length;

describe('C3 agent 工具经生产 pipeline 分层复用', () => {
  it('runner.handles 覆盖每个已注册工具，且 catalog 复用真实参数 schema', () => {
    const { pipeline, runner } = fixture();
    expect(runner.handles('fs_write')).toBe(true);
    expect(runner.handles('bash')).toBe(true);
    expect(runner.handles('http_get')).toBe(true);
    expect(runner.handles('fs_read')).toBe(true);
    expect(runner.handles('unknown_x')).toBe(false);
    expect(pipeline.catalog.resolve('agent:fs.read')).toMatchObject({
      ok: true,
      value: { inputSchema: { required: ['path'] } },
    });
  });

  it('只读 fs_read 也经 pipeline：执行、journal、evidence 均不可绕过', async () => {
    const { dir, db, runner, toolCtx } = fixture();
    const target = join(dir, 'read.txt');
    writeFileSync(target, 'pipeline-read', 'utf8');
    const result = await runner.execute('fs_read', { path: target }, toolCtx());
    expect(result).toMatchObject({ ok: true, value: { output: 'pipeline-read' } });
    const states = db.prepare('SELECT state FROM effect_journal ORDER BY sequence').all().map((row: any) => row.state);
    expect(states).toEqual(['reserved', 'applied', 'committed']);
    expect(evidenceCount(dir)).toBe(1);
  });

  it('同一 Run 内同工具同参数的重复调用各自获得 invocation-bound grant', async () => {
    const { dir, db, runner, toolCtx } = fixture();
    const target = join(dir, 'repeat-read.txt');
    writeFileSync(target, 'repeatable', 'utf8');

    const first = await runner.execute('fs_read', { path: target }, toolCtx());
    const second = await runner.execute('fs_read', { path: target }, toolCtx());

    expect(first).toMatchObject({ ok: true, value: { output: 'repeatable' } });
    expect(second).toMatchObject({ ok: true, value: { output: 'repeatable' } });
    const grants = db.prepare('SELECT context_hash, context_json FROM approval_grants ORDER BY rowid').all()
      .map((row: any) => ({ hash: row.context_hash, context: JSON.parse(row.context_json) }));
    expect(grants).toHaveLength(2);
    expect(grants[0].context.argsHash).toBe(grants[1].context.argsHash);
    expect(grants[0].context.invocationId).not.toBe(grants[1].context.invocationId);
    expect(grants[0].hash).not.toBe(grants[1].hash);
  });

  it('fs_write 经 runner 全链真实执行：文件创建 + grant 落库 + journal applied/committed + evidence 落盘', async () => {
    const { dir, db, pipeline, runner, toolCtx } = fixture();
    const target = join(dir, 'w.txt');
    const result = await runner.execute('fs_write', { path: target, content: 'hello' }, toolCtx());
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(target)).toBe(true);
    // grant 生命周期为 issued→consumed（committed 记入 effect_journal 哈希链，不覆盖 grants.status）
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT status FROM approval_grants").get()).toEqual({ status: 'consumed' });
    const authorization = JSON.parse((db.prepare('SELECT context_json FROM approval_grants').get() as { context_json: string }).context_json);
    expect(authorization).toMatchObject({ actorId: 'actor:test', sessionId: 's1', runId: 'r1' });
    expect(pipeline.uow.verifyJournal()).toMatchObject({ ok: true });
    const states = db.prepare('SELECT state FROM effect_journal ORDER BY sequence').all().map((r: any) => r.state);
    expect(states).toEqual(['reserved', 'applied', 'committed']);
    expect(evidenceCount(dir)).toBe(1);
    const toolEvidenceFile = join(dir, 'evidence', 'tools', readdirSync(join(dir, 'evidence', 'tools'))[0]!);
    const evidence = JSON.parse(readFileSync(toolEvidenceFile, 'utf8'));
    expect(evidence.context).toMatchObject({
      actorId: 'actor:test', sessionId: 's1', runId: 'r1', parentCorrelationId: 'parent-corr',
    });
  });

  it('审批桥绑定 invocationId + canonical argsHash，并且只能消费一次', async () => {
    const { dir, db, pipeline, bridge, runner, toolCtx, context } = fixture();
    const args = { path: join(dir, 'bridge.txt'), content: 'x' };
    const deniedContext = context();
    const denied = await pipeline.pipeline.execute({ id: deniedContext.correlationId, toolId: 'agent:fs.write' as never, args }, deniedContext, new AbortController().signal);
    expect(denied).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(existsSync(join(dir, 'bridge.txt'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 0 });

    const hash = sha256Canonical(args);
    bridge.mark('invocation-1', hash);
    expect(bridge.consume('invocation-2', hash)).toBe(false);
    bridge.mark('invocation-1', hash);
    expect(bridge.consume('invocation-1', sha256Canonical({ ...args, content: 'changed' }))).toBe(false);
    bridge.mark('invocation-1', hash);
    expect(bridge.consume('invocation-1', hash)).toBe(true);
    expect(bridge.consume('invocation-1', hash)).toBe(false);

    const viaRunner = await runner.execute('fs_write', args, toolCtx());
    expect(viaRunner).toMatchObject({ ok: true });
  });

  it('并发 invocation 各自绑定 ToolCtx，不共享可变上下文槽', async () => {
    const { dir, agentTool, runner, toolCtx } = fixture({
      budget: { id: 'budget-1', limits: { externalWrites: 1, networkRequests: 1, processSpawns: 2 } },
    });
    let entered = 0;
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    const probe: ToolDef = {
      schema: { type: 'function', function: { name: 'bash', description: 'ctx probe', parameters: { type: 'object', properties: {} } } },
      danger: true,
      run: async (_args, ctx) => {
        entered++;
        if (entered === 2) openGate();
        await gate;
        return ctx.cwd;
      },
    };
    expect(agentTool.updateTools({ ...coreTools(), bash: probe })).toMatchObject({ ok: true });
    const [first, second] = await Promise.all([
      runner.execute('bash', { command: 'ctx-a' }, toolCtx({ cwd: join(dir, 'cwd-a') })),
      runner.execute('bash', { command: 'ctx-b' }, toolCtx({ cwd: join(dir, 'cwd-b') })),
    ]);
    expect(first).toMatchObject({ ok: true, value: { output: join(dir, 'cwd-a') } });
    expect(second).toMatchObject({ ok: true, value: { output: join(dir, 'cwd-b') } });
  });

  it('approver 拒绝（桥空/被绕过）→ POLICY_DENIED：runner 路径无副作用', async () => {
    const { dir, db, runner, toolCtx } = fixture({ approver: async () => false });
    const target = join(dir, 'denied.txt');
    const result = await runner.execute('fs_write', { path: target, content: 'x' }, toolCtx());
    expect(result).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(existsSync(target)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 0 });
  });

  it('预算强制：externalWrites=1 → 第二次写入 BUDGET_EXCEEDED（fail-closed）', async () => {
    const { dir, runner, toolCtx } = fixture();
    const first = await runner.execute('fs_write', { path: join(dir, 'a.txt'), content: 'a' }, toolCtx());
    expect(first).toMatchObject({ ok: true });
    const second = await runner.execute('fs_write', { path: join(dir, 'b.txt'), content: 'b' }, toolCtx());
    expect(second).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
  });

  it('postcondition 真实再探：文件缺失 → TOOL_POSTCONDITION_FAILED；形状非法 → TOOL_RESULT_INVALID', async () => {
    const { dir, agentTool, context } = fixture();
    const surface = agentTool.surface;
    const missing = await surface.verifyPostcondition('agent:fs.write' as never, { output: '已写入 x', path: join(dir, 'ghost.txt') }, context());
    expect(missing).toMatchObject({ ok: false, error: { code: 'TOOL_POSTCONDITION_FAILED' } });
    const present = await surface.verifyPostcondition('agent:fs.write' as never, { output: '已写入 x', path: __filename }, context());
    expect(present).toMatchObject({ ok: true });
    const badShape = await surface.verifyPostcondition('agent:fs.write' as never, { noOutput: true }, context());
    expect(badShape).toMatchObject({ ok: false, error: { code: 'TOOL_RESULT_INVALID' } });
  });

  it('动态 MCP/plugin 名称通过显式映射调用，catalog reload 可替换并移除旧项', async () => {
    const { agentTool, pipeline, runner, toolCtx } = fixture();
    const calls: string[] = [];
    const dynamic = (name: string, namespace: 'mcp' | 'plugin', output: string): ToolDef => ({
      schema: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } },
      danger: true,
      canonical: { namespace, source: namespace === 'mcp' ? 'Server Name' : 'Plugin Name' },
      run: async ({ value }) => { calls.push(`${name}:${value}`); return output; },
    });
    const mcpName = 'mcp__Server Name__Read.File';
    const pluginName = 'Plugin Tool';
    expect(agentTool.updateTools({
      ...coreTools(),
      [mcpName]: dynamic(mcpName, 'mcp', 'mcp-v1'),
      [pluginName]: dynamic(pluginName, 'plugin', 'plugin-v1'),
    })).toMatchObject({ ok: true });

    const mcpDescriptor = pipeline.catalog.list('agent:runtime').find(tool => String(tool.id).startsWith('mcp:'));
    const pluginDescriptor = pipeline.catalog.list('agent:runtime').find(tool => String(tool.id).startsWith('plugin:'));
    expect(mcpDescriptor?.inputSchema).toMatchObject({ required: ['value'] });
    expect(pluginDescriptor?.inputSchema).toMatchObject({ required: ['value'] });
    expect(await runner.execute(mcpName, { value: 'a' }, toolCtx())).toMatchObject({ ok: true, value: { output: 'mcp-v1' } });
    expect(await runner.execute(pluginName, { value: 'b' }, toolCtx())).toMatchObject({ ok: true, value: { output: 'plugin-v1' } });
    expect(calls).toEqual([`${mcpName}:a`, `${pluginName}:b`]);

    expect(agentTool.updateTools({ ...coreTools() })).toMatchObject({ ok: true });
    expect(runner.handles(mcpName)).toBe(false);
    expect(runner.handles(pluginName)).toBe(false);
    expect(mcpDescriptor && pipeline.catalog.resolve(mcpDescriptor.id)).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_FOUND' } });
    expect(pluginDescriptor && pipeline.catalog.resolve(pluginDescriptor.id)).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_FOUND' } });
  });

  it('Agent 显式空范围 reload 只移除目标 namespace，并同步模型表/runner/catalog', async () => {
    const { dir, db, agentTool, pipeline, runner } = fixture();
    const bus = createEventBus(dir);
    const mem = createMemory(db);
    const dynamic = (name: string, namespace: 'mcp' | 'plugin'): ToolDef => ({
      schema: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
      danger: true,
      canonical: { namespace, source: `${namespace}-fixture` },
      run: async () => name,
    });
    const mcpName = 'mcp__fixture__probe';
    const pluginName = 'plugin_probe';
    let modelTools: string[] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 'reload-empty',
      config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
      extraTools: { [mcpName]: dynamic(mcpName, 'mcp'), [pluginName]: dynamic(pluginName, 'plugin') },
      agentToolRunner: runner,
      onToolTableUpdate: agentTool.updateTools,
      callModel: async req => {
        modelTools = (req.tools ?? []).map((tool: any) => tool.function.name);
        return { type: 'text', content: 'ok' };
      },
    });
    const oldMcp = pipeline.catalog.list('agent:runtime').find(tool => String(tool.id).startsWith('mcp:'))!;

    agent.updateTools({}, { replaceNamespaces: ['mcp'] });
    await agent.run('inspect');

    expect(runner.handles(mcpName)).toBe(false);
    expect(runner.handles(pluginName)).toBe(true);
    expect(modelTools).not.toContain(mcpName);
    expect(modelTools).toContain(pluginName);
    expect(pipeline.catalog.resolve(oldMcp.id)).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_FOUND' } });
    expect(pipeline.catalog.list('agent:runtime').some(tool => String(tool.id).startsWith('plugin:'))).toBe(true);
  });

  it('canonical 同步失败时保留 Agent 模型表、runner 与 catalog 的旧版本', async () => {
    const { dir, db, agentTool, pipeline, runner } = fixture();
    const bus = createEventBus(dir);
    const mem = createMemory(db);
    const tool = (name: string): ToolDef => ({
      schema: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
      danger: false,
      run: async () => name,
    });
    let modelTools: string[] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 'reload-rollback',
      config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
      extraTools: { stable_probe: tool('stable_probe') },
      agentToolRunner: runner,
      onToolTableUpdate: agentTool.updateTools,
      callModel: async req => {
        modelTools = (req.tools ?? []).map((entry: any) => entry.function.name);
        return { type: 'text', content: 'ok' };
      },
    });
    const stable = pipeline.catalog.resolve('agent:stable.probe');
    expect(stable.ok).toBe(true);

    expect(() => agent.updateTools({ sync_probe: tool('sync_probe'), 'sync.probe': tool('sync.probe') }))
      .toThrow(/TOOL_ID_COLLISION/);
    await agent.run('inspect');

    expect(runner.handles('stable_probe')).toBe(true);
    expect(runner.handles('sync_probe')).toBe(false);
    expect(runner.handles('sync.probe')).toBe(false);
    expect(modelTools).toContain('stable_probe');
    expect(modelTools).not.toContain('sync_probe');
    expect(modelTools).not.toContain('sync.probe');
    expect(pipeline.catalog.resolve('agent:stable.probe').ok).toBe(true);
  });

  it('真实 MCP/plugin adapters 均通过同一 pipeline 执行', async () => {
    const { dir, db, agentTool, pipeline, runner, toolCtx } = fixture({
      budget: { id: 'budget-1', limits: { externalWrites: 2, networkRequests: 1, processSpawns: 1 } },
    });
    const mcpCalls: Array<{ name: string; args: Record<string, any> }> = [];
    const client: McpClient = {
      server: { name: 'fixture-server', command: 'unused', toolDanger: { echo: true } },
      connected: true,
      tools: [{ server: 'fixture-server', name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
      async callTool(name, args) { mcpCalls.push({ name, args }); return `mcp:${args.text}`; },
      close() {},
    };
    const pluginDir = join(dir, 'fixture-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'fixture-plugin', enabled: true,
      tools: [{ name: 'plugin_echo', description: 'echo', parameters: { text: { type: 'string' } }, danger: true }],
    }), 'utf8');
    writeFileSync(join(pluginDir, 'index.js'), "export const tools = { plugin_echo: async ({ text }) => 'plugin:' + text };", 'utf8');
    const plugin = await loadPlugin(pluginDir, dir, dir, { trustedInProcessPlugins: ['fixture-plugin'] });
    expect(plugin).not.toBeNull();

    const mcpTools = mcpClientsToTools([client]);
    const pluginTools = pluginToolsToExtra([plugin!]);
    expect(agentTool.updateTools({ ...coreTools(), ...mcpTools, ...pluginTools })).toMatchObject({ ok: true });
    const descriptors = pipeline.catalog.list('agent:runtime');
    expect(descriptors.find(tool => String(tool.id).startsWith('mcp:'))?.inputSchema).toMatchObject({ required: ['text'] });
    expect(descriptors.find(tool => String(tool.id).startsWith('plugin:'))?.inputSchema).toMatchObject({ properties: { text: { type: 'string' } } });

    expect(await runner.execute('mcp__fixture-server__echo', { text: 'a' }, toolCtx())).toMatchObject({ ok: true, value: { output: 'mcp:a' } });
    expect(await runner.execute('plugin_echo', { text: 'b' }, toolCtx())).toMatchObject({ ok: true, value: { output: 'plugin:b' } });
    expect(mcpCalls).toEqual([{ name: 'echo', args: { text: 'a' } }]);
    const states = db.prepare('SELECT state FROM effect_journal ORDER BY sequence').all().map((row: any) => row.state);
    expect(states).toEqual(['reserved', 'applied', 'committed', 'reserved', 'applied', 'committed']);
    expect(evidenceCount(dir)).toBe(2);
  });

  it('未注册 agent toolId → TOOL_NOT_FOUND（resolve 第一端口 fail-closed）', async () => {
    const { pipeline, context } = fixture();
    const result = await pipeline.pipeline.execute({ id: 'eff-nope', toolId: 'agent:not.registered' as never, args: {} }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_FOUND' } });
  });

  it('生产源码只允许 canonical adapter 一处 ToolDef.run 调用', () => {
    const collect = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? collect(path) : entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });
    const calls = collect('src').flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/\btool\.run\s*\(/g)]
        .map(match => `${file.replaceAll('\\', '/')}:${match.index}`),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^src\/application\/tools\/agentToolSurface\.ts:/);
  });

  it('agent 级集成：goal 模式验证副作用 + [GOAL_DONE] → ok=true（与零副作用 incomplete 对照）', async () => {
    const { dir, db, runner } = fixture();
    const bus = createEventBus(dir);
    const mem = createMemory(db);
    const target = join(dir, 'goal-out.txt');
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 'w3-goal', mode: 'goal', workspaceRoot: dir, dataDir: dir,
      config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
      agentToolRunner: runner,
      callModel: async () => {
        calls++;
        return calls === 1
          ? { type: 'tool_call', name: 'fs_write', args: { path: target, content: 'x' } }
          : { type: 'text', content: '任务完成 [GOAL_DONE]' };
      },
    });
    const r = await agent.run('写一个文件');
    expect(r.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 1 });
    const states = db.prepare('SELECT state FROM effect_journal ORDER BY sequence').all().map((row: any) => row.state);
    expect(states).toEqual(['reserved', 'applied', 'committed']);
  });

  it('agent 级对照：默认模式验证副作用 + 「完成了」→ ok=true（完成声明有证据即成功）', async () => {
    const { dir, db, runner } = fixture();
    const bus = createEventBus(dir);
    const mem = createMemory(db);
    const target = join(dir, 'chat-out.txt');
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 'w3-chat', workspaceRoot: dir, dataDir: dir,
      config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
      agentToolRunner: runner,
      onApproval: async () => true,
      callModel: async () => {
        calls++;
        return calls === 1
          ? { type: 'tool_call', name: 'fs_write', args: { path: target, content: 'x' } }
          : { type: 'text', content: '完成了' };
      },
    });
    const r = await agent.run('写文件');
    expect(r.ok).toBe(true);
    expect(r.status).toBeUndefined();
  });
});
