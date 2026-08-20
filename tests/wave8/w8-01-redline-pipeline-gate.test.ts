// tests/wave8/w8-01-redline-pipeline-gate.test.ts — W8-01：红线下沉管线 PDP 复检
// 契约：生产 ToolExecutionPipeline 在 decide 阶段先于策略独立复检硬红线（args 确定性匹配），
// 命中 → HARD_REDLINE_DENIED（任何模式/策略不可绕过）；未命中走正常策略流。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionToolExecution } from '../../src/application/tools/toolExecutionWiring.js';
import { checkRedlineViolation } from '../../src/application/tools/redlineGate.js';
import { openDB, closeDB } from '../../src/store/db.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';
import type { ToolId } from '../../src/domain/tools/toolIds.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const policyDoc = {
  version: 1 as const,
  hardRedlineKinds: [],
  rules: [
    { effectKind: 'memory.read', action: 'allow' as const },
    { effectKind: 'filesystem.read', action: 'allow' as const },
    { effectKind: 'filesystem.write', action: 'require_approval' as const },
    { effectKind: 'network.request', action: 'require_approval' as const },
    { effectKind: 'process.spawn', action: 'allow' as const }, // 刻意 allow——证明红线在策略之上独立拦截
  ],
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'w8-redline-'));
  const db = openDB(dir);
  const memoryRepository = openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
  cleanup.push(() => { try { closeDB(db); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  const pipeline = createProductionToolExecution({
    db, dataDir: dir, workspaceRoot: dir, memoryRepository,
    policy: { id: 'policy-1', document: policyDoc },
    budget: { id: 'budget-1', limits: { externalWrites: 2, networkRequests: 2, processSpawns: 2 } },
    approver: async () => true, // 审批层放行——证明拒绝来自红线而非审批
  });
  let seq = 0;
  const context = (): OperationContext => ({
    actorId: 'actor:test', sessionId: 's1', runId: 'r1', correlationId: `corr-${++seq}`,
    policySnapshotId: 'unused', locale: 'zh-CN', source: 'cli',
    capabilities: [], timestamp: '2026-08-15T00:00:00.000Z',
  });
  return { dir, db, pipeline, context };
}

describe('W8-01 红线下沉管线 PDP 复检', () => {
  it('checkRedlineViolation 命中破坏性命令（rm -rf 根目录 / format 盘符 / diskpart）', () => {
    expect(checkRedlineViolation({ command: 'rm -rf /' }).id).toBe('redline.rm-rf-root-home');
    expect(checkRedlineViolation({ command: 'rm -rf C:\\' }).id).toBe('redline.rm-rf-root-home');
    expect(checkRedlineViolation({ command: 'format C:' }).id).toBe('redline.format-drive');
    expect(checkRedlineViolation({ command: 'diskpart' }).id).toBe('redline.diskpart');
    expect(checkRedlineViolation({ command: 'dir' }).id).toBeNull();
    expect(checkRedlineViolation({ path: 'a.txt', content: 'x' }).id).toBeNull();
  });

  it('管线 decide 阶段独立拦截红线：策略 allow + 审批放行也不可绕过 → HARD_REDLINE_DENIED 零副作用', async () => {
    const { pipeline, context } = fixture();
    const result = await pipeline.pipeline.execute(
      { id: 'eff-redline', toolId: 'builtin:process.spawn' as ToolId, args: { command: 'rm -rf C:\\' } },
      context(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('HARD_REDLINE_DENIED');
  });

  it('非红线 spawn 走正常策略流（allow → 审批 → 执行端口）——红线不误伤', async () => {
    const { pipeline, context } = fixture();
    const result = await pipeline.pipeline.execute(
      { id: 'eff-benign', toolId: 'builtin:process.spawn' as ToolId, args: { command: 'dir' } },
      context(),
      new AbortController().signal,
    );
    // 执行端口未接线（TOOL_EXECUTOR_UNWIRED）是诚实结果——关键是绝不因红线误拒
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe('HARD_REDLINE_DENIED');
  });
});
