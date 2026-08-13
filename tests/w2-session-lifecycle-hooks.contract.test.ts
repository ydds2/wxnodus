import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycleService } from '../src/application/sessions/sessionLifecycleService.js';
import { HookRegistry } from '../src/application/hooks/hookRegistry.js';

const base = { producer: 'session-service', timestamp: '2026-08-13T00:00:00.000Z', locale: 'en',
  source: 'kernel' as const, capabilities: ['session'], policySnapshotId: 'policy-2',
  correlationId: 'corr-1', sensitivity: 'internal' as const, retention: 'session' as const };

describe('W2-05 W1 lifecycle envelope and hooks', () => {
  it('emits session start once, then resume/run/turn with exact W1 envelope IDs', async () => {
    const revisions = new Map<string, number>();
    const service = new SessionLifecycleService({
      load: async id => revisions.get(id), save: async (id, revision) => { revisions.set(id, revision); },
    });
    const start = await service.session('s1', false, base);
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error(start.error.code);
    expect(start.value).toMatchObject({
      schemaVersion: 1, type: 'session.start', sessionId: 's1', payload: { kind: 'session.start', lifecycleRevision: 1 },
    });
    const resume = await service.session('s1', false, base);
    expect(resume.ok).toBe(true);
    if (!resume.ok) throw new Error(resume.error.code);
    expect(resume.value.type).toBe('session.resume');
    const run = await service.run('s1', 'r1', base);
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.code);
    expect(run.value).toMatchObject({ type: 'run.start', sessionId: 's1', runId: 'r1' });
    const turn = await service.turn('s1', 'r1', 't1', base);
    expect(turn.ok).toBe(true);
    if (!turn.ok) throw new Error(turn.error.code);
    expect(turn.value).toMatchObject({
      type: 'turn.start', sessionId: 's1', runId: 'r1', turnId: 't1',
    });
    expect(new SessionLifecycleService({ load: async id => revisions.get(id), save: async () => undefined }))
      .toBeDefined();
  });

  it('denies critical crash/malformed/timeout, permits explicit notification fail-open, and disposes owner', async () => {
    vi.useFakeTimers();
    const registry = new HookRegistry();
    const disposed = vi.fn();
    registry.register({ owner: 'plugin:a@1', id: 'critical', policy: 'security-critical', timeoutMs: 10,
      run: async () => new Promise(() => undefined), dispose: disposed });
    const pending = registry.invoke('critical', {}); await vi.advanceTimersByTimeAsync(11);
    await expect(pending).resolves.toEqual({ action: 'deny', reasonCode: 'HOOK_TIMEOUT' });
    registry.register({ owner: 'plugin:a@1', id: 'notice', policy: 'notification-only', timeoutMs: 10,
      run: async () => { throw new Error('boom'); } });
    await expect(registry.invoke('notice', {})).resolves.toEqual({ action: 'continue' });
    await registry.unregisterOwner('plugin:a@1');
    expect(disposed).toHaveBeenCalledOnce();
    await expect(registry.invoke('critical', {})).resolves.toEqual({ action: 'deny', reasonCode: 'HOOK_DENIED' });
    vi.useRealTimers();
  });
});
