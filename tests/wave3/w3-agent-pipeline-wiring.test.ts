// tests/wave3/w3-agent-pipeline-wiring.test.ts — C3 契约：agent 主路径经生产 11-port pipeline 真实执行（分层复用）
// 审批权威在 agent 前置链；pipeline 为强制记账层（PDP 复核 → grant/budget → effect-journal → evidence
// → postcondition 真实再探）。审批桥 WeakMap：runner 标记 legacy 已放行，approver 读桥（不二次弹窗）。
// fail-closed 全锁定：未标记/拒绝 → POLICY_DENIED 零副作用；超预算 → BUDGET_EXCEEDED；未知 id → TOOL_NOT_FOUND。
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../src/store/db.js';
import { createEventBus } from '../../src/kernel/events.js';
import { createMemory } from '../../src/kernel/memory.js';
import { createAgent } from '../../src/kernel/agent.js';
import { coreTools, type ToolCtx } from '../../src/kernel/tools.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import { createProductionToolExecution, type ToolExecutionWiringOptions } from '../../src/application/tools/toolExecutionWiring.js';
import { createAgentToolSurface, createAgentApprovalBridge } from '../../src/application/tools/agentToolSurface.js';
import type { PolicyDocument } from '../../src/domain/security/pdp.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';

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
    approver: request => Promise.resolve(String(request.toolId).startsWith('agent:') ? bridge.consume(request.args) : true),
    ...overrides,
  });
  const agentTool = createAgentToolSurface({ tools: coreTools() });
  const registered = pipeline.registerAgentTools(agentTool.surface);
  if (!registered.ok) throw new Error(registered.error.code);
  const runner = agentTool.attach(pipeline.pipeline, bridge);
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
  it('runner.handles 只覆盖注册的 danger/写类工具；只读工具与未知名不覆盖（诚实 shadow）', () => {
    const { runner } = fixture();
    expect(runner.handles('fs_write')).toBe(true);
    expect(runner.handles('bash')).toBe(true);
    expect(runner.handles('http_get')).toBe(true);
    expect(runner.handles('fs_read')).toBe(false); // 只读维持 legacy
    expect(runner.handles('unknown_x')).toBe(false);
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
    expect(pipeline.uow.verifyJournal()).toMatchObject({ ok: true });
    const states = db.prepare('SELECT state FROM effect_journal ORDER BY sequence').all().map((r: any) => r.state);
    expect(states).toEqual(['reserved', 'applied', 'committed']);
    expect(evidenceCount(dir)).toBe(1);
  });

  it('审批桥：未 mark（legacy 未放行）→ POLICY_DENIED 零副作用零 grant；mark 后放行（WeakMap 语义）', async () => {
    const { dir, db, pipeline, bridge, runner, toolCtx, context } = fixture();
    const args = { path: join(dir, 'bridge.txt'), content: 'x' };
    const denied = await pipeline.pipeline.execute({ id: 'eff-bridge-1', toolId: 'agent:fs.write' as never, args }, context(), new AbortController().signal);
    expect(denied).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(existsSync(join(dir, 'bridge.txt'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 0 });
    // 桥语义：consume 未标记为 false；mark 后同一 args 对象身份 → true
    expect(bridge.consume({ nope: true })).toBe(false);
    bridge.mark(args, true);
    expect(bridge.consume(args)).toBe(true);
    // 直调 pipeline 无法执行 agent 工具（无 runner 绑定 toolCtx → fail-closed 边界）；
    // 全链放行路径由 runner 承载（见上一用例）——此处 runner 正常放行作对照
    const viaRunner = await runner.execute('fs_write', args, toolCtx());
    expect(viaRunner).toMatchObject({ ok: true });
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

  it('未注册 agent toolId → TOOL_NOT_FOUND（resolve 第一端口 fail-closed）', async () => {
    const { pipeline, context } = fixture();
    const result = await pipeline.pipeline.execute({ id: 'eff-nope', toolId: 'agent:fs.read' as never, args: {} }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_FOUND' } });
  });

  it('agent 级集成：goal 模式验证副作用 + [GOAL_DONE] → ok=true（与零副作用 incomplete 对照）', async () => {
    const { dir, db, runner } = fixture();
    const bus = createEventBus(dir);
    const mem = createMemory(db);
    const target = join(dir, 'goal-out.txt');
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 'w3-goal', mode: 'goal',
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
      db, bus, mem, sessionId: 'w3-chat',
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
