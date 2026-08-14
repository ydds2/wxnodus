// tests/wave3/w3-tool-execution-wiring.test.ts — W1-08 生产接线契约（RED）
// 11 ports 全真实：resolve/validate/normalize/decide/authorizeAndReserve/execute/appendJournal/
// verifyPostcondition/captureEvidence/commitBudget/releaseBudget——真实 SQLite 控制面 +
// 真实文件系统 executor + 真实证据落盘 + 哈希链 journal。fail-closed 路径全部锁定。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../src/store/db.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import { createProductionToolExecution, type ToolExecutionWiringOptions } from '../../src/application/tools/toolExecutionWiring.js';
import { evidenceFile } from '../../src/application/tools/toolEvidenceStore.js';
import type { PolicyDocument } from '../../src/domain/security/pdp.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';

const policyDoc: PolicyDocument = {
  version: 1,
  hardRedlineKinds: ['process.spawn'],
  rules: [
    { effectKind: 'memory.read', action: 'allow' },
    { effectKind: 'filesystem.read', action: 'allow' },
    { effectKind: 'filesystem.write', action: 'require_approval' },
    { effectKind: 'network.request', action: 'require_approval' },
  ],
};

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

function fixture(overrides: Partial<ToolExecutionWiringOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w3-tool-pipeline-'));
  const db = openDB(dir);
  const memoryRepository = openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
  cleanup.push(() => { try { closeDB(db); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  const pipeline = createProductionToolExecution({
    db, dataDir: dir, workspaceRoot: dir, memoryRepository,
    policy: { id: 'policy-1', document: policyDoc },
    budget: { id: 'budget-1', limits: { externalWrites: 2, networkRequests: 2, processSpawns: 1 } },
    ...overrides,
  });
  let seq = 0;
  const context = (): OperationContext => ({
    actorId: 'actor:test', sessionId: 's1', runId: 'r1', correlationId: `corr-${++seq}`,
    policySnapshotId: 'unused（authorize 以仓储活动快照为可信源）', locale: 'zh-CN', source: 'cli',
    capabilities: [], timestamp: '2026-08-13T00:00:00.000Z',
  });
  return { dir, db, pipeline, context };
}

describe('W1-08 production tool execution pipeline', () => {
  it('full allow round-trip: memory.read → verified receipt + journal chain + evidence on disk', async () => {
    const { dir, db, pipeline, context } = fixture();
    const ctx = context();
    const result = await pipeline.pipeline.execute({ id: 'eff-mem', toolId: 'builtin:memory' as never, args: {} }, ctx, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { effectId: 'eff-mem', state: 'verified', evidenceIds: [`tool-evidence-${ctx.correlationId}`] } });
    expect(pipeline.uow.verifyJournal()).toMatchObject({ ok: true });
    const parsed = JSON.parse(readFileSync(evidenceFile(dir, ctx.correlationId), 'utf8')) as { journal: string[]; value: { records?: unknown[] } };
    expect(parsed.journal).toEqual(['applied']);
    expect(Array.isArray(parsed.value.records)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 1 });
  });

  it('require_approval without approver fails closed (APPROVAL_UNAVAILABLE), no side effects', async () => {
    const { db, pipeline, context } = fixture({ approver: undefined });
    const result = await pipeline.pipeline.execute({
      id: 'eff-noapprove', toolId: 'builtin:workspace.write' as never, args: { path: 'a.txt', bytesBase64: Buffer.from('x').toString('base64') },
    }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'APPROVAL_UNAVAILABLE' } });
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 0 });
  });

  it('approver denial → POLICY_DENIED, no grant, no journal', async () => {
    const { db, pipeline, context } = fixture({ approver: async () => false });
    const result = await pipeline.pipeline.execute({
      id: 'eff-deny', toolId: 'builtin:workspace.write' as never, args: { path: 'b.txt', bytesBase64: Buffer.from('x').toString('base64') },
    }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 0 });
  });

  it('workspace.write with approval writes for real, postcondition re-checks, journal reserved→applied→committed', async () => {
    const { dir, db, pipeline, context } = fixture({ approver: async () => true });
    const target = join(dir, 'real-write.txt');
    const content = '生产管线真实写入';
    const result = await pipeline.pipeline.execute({
      id: 'eff-write', toolId: 'builtin:workspace.write' as never,
      args: { path: target, bytesBase64: Buffer.from(content).toString('base64') },
    }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { state: 'verified' } });
    expect(readFileSync(target, 'utf8')).toBe(content);
    const states = (db.prepare('SELECT state FROM effect_journal ORDER BY sequence').all() as Array<{ state: string }>).map(r => r.state);
    expect(states).toContain('reserved');
    expect(states).toContain('applied');
    expect(states).toContain('committed');
    // workspace.read（allow）读回同一文件
    const readBack = await pipeline.pipeline.execute({
      id: 'eff-read', toolId: 'builtin:workspace.read' as never, args: { path: target },
    }, context(), new AbortController().signal);
    expect(readBack).toMatchObject({ ok: true, value: { state: 'verified' } });
  });

  it('workspace path escape fails closed and releases the reservation (budget refunded)', async () => {
    const { dir, db, pipeline, context } = fixture({ approver: async () => true });
    const used = () => JSON.parse((db.prepare('SELECT used_json FROM budget_snapshots WHERE active=1').get() as { used_json: string }).used_json) as Record<string, number>;
    const before = used();
    const result = await pipeline.pipeline.execute({
      id: 'eff-escape', toolId: 'builtin:workspace.write' as never,
      args: { path: join(dir, '..', 'escape.txt'), bytesBase64: Buffer.from('x').toString('base64') },
    }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'BUILD_PATH_OUTSIDE_WORKSPACE' } });
    expect(used()).toEqual(before); // release 退款——失败不留预算残渣
    expect(pipeline.uow.verifyJournal()).toMatchObject({ ok: true });
  });

  it('budget limit enforces BUDGET_EXCEEDED on the third write (limit 2)', async () => {
    const { dir, pipeline, context } = fixture({ approver: async () => true });
    const write = (id: string, file: string) => pipeline.pipeline.execute({
      id, toolId: 'builtin:workspace.write' as never,
      args: { path: join(dir, file), bytesBase64: Buffer.from('y').toString('base64') },
    }, context(), new AbortController().signal);
    expect(await write('eff-b1', 'budget-1.txt')).toMatchObject({ ok: true });
    expect(await write('eff-b2', 'budget-2.txt')).toMatchObject({ ok: true });
    expect(await write('eff-b3', 'budget-3.txt')).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(existsSync(join(dir, 'budget-3.txt'))).toBe(false);
  });

  it('hard redline (process.spawn) is denied at the PDP before any side effect', async () => {
    const { db, pipeline, context } = fixture();
    const result = await pipeline.pipeline.execute({
      id: 'eff-spawn', toolId: 'builtin:process.spawn' as never, args: { executable: 'cmd.exe', args: ['/c', 'echo hi'] },
    }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(db.prepare('SELECT COUNT(*) c FROM approval_grants').get()).toEqual({ c: 0 });
  });

  it('unwired tool id resolves to TOOL_NOT_FOUND (no fake execution)', async () => {
    const { pipeline, context } = fixture();
    const result = await pipeline.pipeline.execute({
      id: 'eff-unknown', toolId: 'builtin:nonexistent' as never, args: {},
    }, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_FOUND' } });
  });

  it('pre-cancelled signal → OPERATION_CANCELLED with no reservation leak', async () => {
    const { db, pipeline, context } = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await pipeline.pipeline.execute({
      id: 'eff-cancel', toolId: 'builtin:memory' as never, args: {},
    }, context(), controller.signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_CANCELLED' } });
    expect(JSON.parse((db.prepare('SELECT used_json FROM budget_snapshots WHERE active=1').get() as { used_json: string }).used_json)).toEqual({});
  });

  it('MCP delivered memory surface executes through the production pipeline (real verified receipt)', async () => {
    process.env.WXNODUS_MCP_REQUEST_STATE_KEY = Buffer.alloc(32, 1).toString('base64');
    const { WxNodusMcpAdapter } = await import('../../src/infrastructure/mcp/wxnodusMcpServer.js');
    const { InMemoryMcpTranscriptStore } = await import('../../src/infrastructure/mcp/mcpTranscriptStore.js');
    const { buildMcpMeta } = await import('../../src/domain/mcp/mcpProtocol.js');
    const { pipeline, context } = fixture();
    const transcript = new InMemoryMcpTranscriptStore(() => '2026-08-13T00:00:00.000Z');
    const adapter = new WxNodusMcpAdapter({
      capabilities: {
        snapshot: () => ({ id: 'caps-1' }),
        require: (id: string) => id === 'memory'
          ? ({ ok: true as const, value: { id, snapshotId: 'caps-1' } })
          : ({ ok: false as const, error: { code: 'CAPABILITY_UNAVAILABLE' } }),
      } as never,
      pipeline: pipeline.pipeline as never,
      transcript,
      contextFactory: () => context(),
    });
    const meta = buildMcpMeta({ name: 'test', version: '1' }, { tools: {}, resources: {}, prompts: {} });
    const result = await adapter.call('memory', {}, meta, context(), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { state: 'verified', toolId: 'builtin:memory' } });
    expect(transcript.records().at(-1)).toMatchObject({ status: 'ok' });
    delete process.env.WXNODUS_MCP_REQUEST_STATE_KEY;
  });

  it('plugin broker routes workspace.read through the production pipeline (path boundary enforced)', async () => {
    const { createPluginBroker } = await import('../../src/infrastructure/plugins/pluginProtocol.js');
    const { dir, pipeline, context } = fixture({ approver: async () => true });
    const target = join(dir, 'plugin-read.txt');
    writeFileSync(target, '插件能力读取', 'utf8');
    const broker = createPluginBroker({ pipeline: pipeline.pipeline });
    const okRead = await broker.request('plugin-1', { id: 'req-1', kind: 'workspace.read', path: target }, context(), new AbortController().signal);
    expect(okRead).toMatchObject({ ok: true, value: { requestId: 'req-1' } });
    // 越界读 fail-closed（绝不静默放行）
    const escaped = await broker.request('plugin-1', { id: 'req-2', kind: 'workspace.read', path: join(dir, '..', 'outside.txt') }, context(), new AbortController().signal);
    expect(escaped).toMatchObject({ ok: false, error: { code: 'BUILD_PATH_OUTSIDE_WORKSPACE' } });
    // process.spawn 在本 fixture 策略 hard redline → PDP 直接拒绝（先于审批）
    const noApprover = fixture();
    const broker2 = createPluginBroker({ pipeline: noApprover.pipeline.pipeline });
    const spawn = await broker2.request('plugin-1', { id: 'req-3', kind: 'process.spawn', executable: 'cmd.exe', args: [] }, noApprover.context(), new AbortController().signal);
    expect(spawn).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
  });
});
