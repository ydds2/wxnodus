// tests/w2-subagent-worktree-recovery.contract.test.ts — W2-10 扩展契约：worktree 路径/owned files、lineage 预算收窄、
// lease recovery（CAS orphaned → 三稳定决策）、cancellation fence
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryService } from '../src/application/autonomy/recoveryService.js';
import { narrowBudgets, narrowScope, SubagentService, assertOwnedFileScope } from '../src/application/autonomy/subagentService.js';
import { SubagentHost } from '../src/infrastructure/autonomy/subagentHost.js';
import { WorktreeManager } from '../src/infrastructure/autonomy/worktreeManager.js';
import { RecoveryRepository } from '../src/infrastructure/sqlite/recoveryRepository.js';
import { ALL_BUDGET_DIMENSIONS } from '../src/domain/autonomy/budgetDimensions.js';

let db: InstanceType<typeof Database>;
let root: string;
beforeEach(() => {
  db = new Database(':memory:');
  root = mkdtempSync(join(tmpdir(), 'wxnodus-w2-10-'));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const fullBudget = Object.fromEntries(ALL_BUDGET_DIMENSIONS.map(dimension => [dimension, 100])) as Record<typeof ALL_BUDGET_DIMENSIONS[number], number>;

describe('W2-10 worktree and lineage recovery', () => {
  it('rejects path escape and out-of-scope owned files', async () => {
    const manager = new WorktreeManager({
      dataDir: root,
      git: vi.fn(async () => ({ ok: true as const, value: { stdout: '', stderr: '' } })),
      realpath: async path => path,
    });
    expect(await manager.assertTaskIdSafe('../escape', `${root}/worktrees/../escape`)).toMatchObject({
      ok: false,
      error: { code: 'WORKTREE_PATH_ESCAPE' },
    });
    expect(manager.assertOwnedFiles(['proj/src'], ['proj/src/a.ts', 'proj/src/b.ts'])).toMatchObject({ ok: true });
    expect(manager.assertOwnedFiles(['proj/src'], ['proj/src/a.ts', 'C:/outside/x.ts'])).toMatchObject({
      ok: false,
      error: { code: 'OWNED_FILE_SCOPE_DENIED' },
    });
    expect(await manager.add('task-1', 'abc123')).toMatchObject({ ok: true, value: { path: manager.worktreePath('task-1') } });
  });

  it('narrows budgets per dimension with min(parentRemaining, requested) and only narrows scope', () => {
    const narrowed = narrowBudgets(fullBudget, { token: 10, depth: 3, fanout: 2, 'concurrent-agent': 1 });
    expect(narrowed.token).toBe(10);
    expect(narrowed.depth).toBe(3);
    expect(narrowed.wallclock).toBe(100);
    expect(narrowed['concurrent-agent']).toBe(1);
    const scope = narrowScope({ toolIds: ['fs_read', 'fs_write'], filePaths: ['/a'], secretIds: ['s1'] }, {
      toolIds: ['fs_write', 'http_get'], filePaths: ['/a', '/b'], secretIds: ['s2'],
    });
    expect(scope).toEqual({ toolIds: ['fs_write'], filePaths: ['/a'], secretIds: [] });
    expect(assertOwnedFileScope(['proj'], ['proj/x'])).toMatchObject({ ok: true });
  });

  it('fences lineage before abort on cancel and waits for a stop receipt', async () => {
    const order: string[] = [];
    const host = new SubagentHost({
      spawn: vi.fn(async () => ({ processId: 9, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false })),
      terminateTree: vi.fn(async () => { order.push('terminate'); return { ok: true as const, value: undefined }; }),
      fence: vi.fn(async () => { order.push('fence'); return { ok: true as const, value: undefined }; }),
    });
    const receipt = await host.start({ taskId: 't1', executable: 'node', argv: ['x'], cwd: root }, AbortSignal.timeout(100));
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const stopped = await host.cancel(receipt.value, ['run-parent', 'run-child'], () => order.push('abort'));
    expect(order).toEqual(['fence', 'abort', 'fence', 'terminate']);
    expect(stopped).toMatchObject({ ok: true, value: { taskId: 't1', processId: 9, fenced: true } });
  });

  it('recovers only after lease expiry: CAS orphaned → resume/reconcile/manual-review', async () => {
    const repo = new RecoveryRepository(db);
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const checkpoint = { runId: 'r1', attemptId: 'a1', leaseExpiresAt: past, worktreePath: `${root}/wt`, baseCommit: 'b', headCommit: 'h', ownedFiles: ['src'], evidenceIds: ['e1'] };
    repo.saveCheckpoint({ ...checkpoint, leaseExpiresAt: future });
    repo.upsertLease('r1', 'a1', 'active');
    const activeService = new RecoveryService(repo, {
      now: () => Date.now(),
      verifyWorktree: vi.fn(async () => []),
      verifyEvidence: vi.fn(async () => true),
      createRecoveryAttempt: vi.fn(async () => 2),
    });
    expect(await activeService.recover('r1')).toMatchObject({ ok: false, error: { code: 'RECOVERY_LEASE_ACTIVE' } });

    repo.saveCheckpoint(checkpoint);
    const resumeService = new RecoveryService(repo, {
      now: () => Date.now(),
      verifyWorktree: vi.fn(async () => []),
      verifyEvidence: vi.fn(async () => true),
      createRecoveryAttempt: vi.fn(async () => 2),
    });
    expect(await resumeService.recover('r1')).toMatchObject({ ok: true, value: { decision: 'resume-from-checkpoint', newAttemptOrdinal: 2 } });
    expect(repo.leaseStatus('r1', 'a1')).toBe('orphaned');

    repo.upsertLease('r1', 'a2', 'active');
    repo.saveCheckpoint({ ...checkpoint, attemptId: 'a2' });
    const driftService = new RecoveryService(repo, {
      now: () => Date.now(),
      verifyWorktree: vi.fn(async () => ['src/extra.txt']),
      verifyEvidence: vi.fn(async () => true),
      createRecoveryAttempt: vi.fn(async () => 3),
    });
    expect(await driftService.recover('r1')).toMatchObject({ ok: true, value: { decision: 'reconcile-worktree' } });

    repo.upsertLease('r1', 'a3', 'active');
    repo.saveCheckpoint({ ...checkpoint, attemptId: 'a3' });
    const brokenService = new RecoveryService(repo, {
      now: () => Date.now(),
      verifyWorktree: vi.fn(async () => ['src/x']),
      verifyEvidence: vi.fn(async () => false),
      createRecoveryAttempt: vi.fn(async () => 4),
    });
    expect(await brokenService.recover('r1')).toMatchObject({ ok: true, value: { decision: 'manual-review' } });
    expect(repo.loadDecision('r1')).toBe('manual-review');
  });
});
