// tests/session-run-coordinator.test.ts — P0-2 Run 身份、FIFO 所有权与唯一终态
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionRunCoordinator,
  RunAdmissionClosedError,
  RunIdentityConflictError,
  RunShutdownTimeoutError,
} from '../src/application/runs/sessionRunCoordinator.js';
import { createEventBus } from '../src/kernel/events.js';
import { aggregateRunFinalStatuses, createRunContext, normalizeAgentRunStatus, RUN_FINAL_STATUSES } from '../src/protocol/runs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-run-'));
  dirs.push(dir);
  const bus = createEventBus(dir);
  let sessionId = 'home';
  let aborts = 0;
  const agent = {
    getSessionId: () => sessionId,
    setSessionId: (id: string) => { sessionId = id; },
    abort: () => { aborts += 1; },
  };
  return { bus, agent, coordinator: createSessionRunCoordinator({ agent, bus }), getAborts: () => aborts };
}

const ctx = (runId: string, sessionId: string) => createRunContext({
  runId,
  correlationId: `corr-${runId}`,
  sessionId,
});

const success = { ok: true, interrupted: false };

describe('SessionRunCoordinator', () => {
  it('serializes the shared Agent FIFO and restores its original session', async () => {
    const h = harness();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = h.coordinator.execute({
      context: ctx('run-a', 'session-a'),
      operation: async () => {
        order.push(`start:${h.agent.getSessionId()}`);
        await firstGate;
        order.push(`end:${h.agent.getSessionId()}`);
        return success;
      },
      classify: normalizeAgentRunStatus,
    });
    const second = h.coordinator.execute({
      context: ctx('run-b', 'session-b'),
      operation: async () => {
        order.push(`start:${h.agent.getSessionId()}`);
        return success;
      },
      classify: normalizeAgentRunStatus,
    });

    await Promise.resolve();
    expect(order).toEqual(['start:session-a']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'succeeded' },
      { status: 'succeeded' },
    ]);
    expect(order).toEqual(['start:session-a', 'end:session-a', 'start:session-b']);
    expect(h.agent.getSessionId()).toBe('home');
  });

  it('propagates immutable identity through asynchronous events and emits one final event', async () => {
    const h = harness();
    const context = ctx('run-events', 'session-events');
    const result = await h.coordinator.execute({
      context,
      operation: async () => {
        await Promise.resolve();
        h.bus.emit('agent.token', { text: 'ok' });
        return success;
      },
      classify: normalizeAgentRunStatus,
    });

    expect(result.context).toBe(context);
    const events = h.bus.history().filter(event => event.runId === context.runId);
    expect(events.map(event => event.type)).toEqual(['agent.token', 'run.final']);
    expect(events.every(event => event.correlationId === context.correlationId)).toBe(true);
    expect(events.every(event => event.sessionId === context.sessionId)).toBe(true);
    expect(events.filter(event => event.type === 'run.final')).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({ status: 'succeeded', runId: context.runId });
  });

  it('classifies operation errors and pre-start cancellation with one terminal fact each', async () => {
    const h = harness();
    const failed = await h.coordinator.execute({
      context: ctx('run-failed', 'session-a'),
      operation: async () => { throw new Error('boom'); },
      classify: normalizeAgentRunStatus,
    });
    const abortController = new AbortController();
    abortController.abort();
    let called = false;
    const cancelled = await h.coordinator.execute({
      context: ctx('run-cancelled', 'session-b'),
      signal: abortController.signal,
      operation: async () => { called = true; return success; },
      classify: normalizeAgentRunStatus,
    });

    expect(failed).toMatchObject({ status: 'failed', error: 'boom' });
    expect(cancelled.status).toBe('cancelled');
    expect(called).toBe(false);
    expect(h.bus.history().filter(event => event.type === 'run.final')).toHaveLength(2);
  });

  it('aborts only the active operation when its signal fires', async () => {
    const h = harness();
    const abortController = new AbortController();
    const result = await h.coordinator.execute({
      context: ctx('run-abort', 'session-a'),
      signal: abortController.signal,
      operation: async () => {
        abortController.abort();
        return { ok: false, interrupted: true };
      },
      classify: normalizeAgentRunStatus,
    });
    expect(result.status).toBe('cancelled');
    expect(h.getAborts()).toBe(1);
  });

  it('preserves only an intentional successful session switch', async () => {
    const h = harness();
    await h.coordinator.execute({
      context: ctx('run-switch', 'session-a'),
      sessionDisposition: 'preserve-change',
      operation: async () => {
        h.agent.setSessionId('session-next');
        return success;
      },
      classify: normalizeAgentRunStatus,
    });
    expect(h.agent.getSessionId()).toBe('session-next');

    await h.coordinator.execute({
      context: ctx('run-no-switch', 'session-b'),
      sessionDisposition: 'preserve-change',
      operation: async () => success,
      classify: normalizeAgentRunStatus,
    });
    expect(h.agent.getSessionId()).toBe('session-next');

    await h.coordinator.execute({
      context: ctx('run-failed-switch', 'session-c'),
      sessionDisposition: 'preserve-change',
      operation: async () => {
        h.agent.setSessionId('session-invalid');
        return { ok: false, interrupted: false };
      },
      classify: normalizeAgentRunStatus,
    });
    expect(h.agent.getSessionId()).toBe('session-next');
  });

  it('cancels queued work before invoking its operation', async () => {
    const h = harness();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = h.coordinator.execute({
      context: ctx('run-queue-first', 'session-a'),
      operation: async () => { await firstGate; return success; },
      classify: normalizeAgentRunStatus,
    });
    const controller = new AbortController();
    let called = false;
    const queued = h.coordinator.execute({
      context: ctx('run-queue-cancelled', 'session-b'),
      signal: controller.signal,
      operation: async () => { called = true; return success; },
      classify: normalizeAgentRunStatus,
    });

    controller.abort();
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 'succeeded' });
    await expect(queued).resolves.toMatchObject({ status: 'cancelled' });
    expect(called).toBe(false);
    expect(h.getAborts()).toBe(0);
  });

  it('closes admission synchronously with a stable typed error', async () => {
    const h = harness();
    const shutdown = h.coordinator.shutdown('test-shutdown');
    expect(() => h.coordinator.execute({
      context: ctx('run-after-shutdown', 'session-a'),
      operation: async () => success,
      classify: normalizeAgentRunStatus,
    })).toThrow(RunAdmissionClosedError);

    await expect(shutdown).resolves.toBeUndefined();
    expect(h.coordinator.has('run-after-shutdown')).toBe(false);
    expect(h.bus.history().filter(event => event.runId === 'run-after-shutdown')).toHaveLength(0);
  });

  it('shutdown aborts active work, cancels queued work, drains every final, and is idempotent', async () => {
    const h = harness();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>(resolve => { releaseActive = resolve; });
    let queuedCalled = false;
    const active = h.coordinator.execute({
      context: ctx('run-shutdown-active', 'session-a'),
      operation: async () => {
        await activeGate;
        return success;
      },
      classify: normalizeAgentRunStatus,
    });
    const queued = h.coordinator.execute({
      context: ctx('run-shutdown-queued', 'session-b'),
      operation: async () => {
        queuedCalled = true;
        return success;
      },
      classify: normalizeAgentRunStatus,
    });
    await Promise.resolve();

    let shutdownSettled = false;
    const firstShutdown = h.coordinator.shutdown('process-exit').then(() => { shutdownSettled = true; });
    const secondShutdown = h.coordinator.shutdown('ignored-later-reason');

    expect(h.getAborts()).toBe(1);
    expect(shutdownSettled).toBe(false);
    expect(queuedCalled).toBe(false);
    releaseActive();

    await expect(Promise.all([active, queued])).resolves.toMatchObject([
      { status: 'cancelled' },
      { status: 'cancelled' },
    ]);
    await expect(Promise.all([firstShutdown, secondShutdown])).resolves.toEqual([undefined, undefined]);
    expect(queuedCalled).toBe(false);
    expect(h.getAborts()).toBe(1);
    for (const runId of ['run-shutdown-active', 'run-shutdown-queued']) {
      const finals = h.bus.history().filter(event => event.type === 'run.final' && event.runId === runId);
      expect(finals).toHaveLength(1);
      expect(finals[0]?.payload).toMatchObject({ status: 'cancelled' });
    }
  });

  it('emits run.final after all run-scoped projections', async () => {
    const h = harness();
    const context = ctx('run-projection-order', 'session-a');
    await h.coordinator.execute({
      context,
      operation: async () => success,
      classify: normalizeAgentRunStatus,
      beforeRelease: () => { h.bus.emit('session.changed', { activeSessionId: 'session-b' }); },
    });

    const events = h.bus.history().filter(event => event.runId === context.runId);
    expect(events.map(event => event.type)).toEqual(['session.changed', 'run.final']);
  });

  it('seals inherited async work after run.final', async () => {
    const h = harness();
    const context = ctx('run-detached-event', 'session-a');
    let emitLate!: () => void;
    const late = new Promise<void>(resolve => {
      emitLate = () => {
        h.bus.emit('agent.token', { text: 'late' });
        resolve();
      };
    });
    await h.coordinator.execute({
      context,
      operation: async () => {
        setTimeout(emitLate, 0);
        return success;
      },
      classify: normalizeAgentRunStatus,
    });
    await late;

    const scoped = h.bus.history().filter(event => event.runId === context.runId);
    expect(scoped.map(event => event.type)).toEqual(['run.final']);
    expect(h.bus.history().find(event => event.payload?.text === 'late')?.runId).toBeUndefined();
  });

  it('bounds shutdown when active work ignores cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-run-timeout-'));
    dirs.push(dir);
    const bus = createEventBus(dir);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const coordinator = createSessionRunCoordinator({
      agent: { abort() {} },
      bus,
      shutdownTimeoutMs: 10,
    });
    const active = coordinator.execute({
      context: ctx('run-shutdown-timeout', 'session-a'),
      operation: async () => { await gate; return success; },
      classify: normalizeAgentRunStatus,
    });
    await Promise.resolve();

    await expect(coordinator.shutdown('timeout-test')).rejects.toBeInstanceOf(RunShutdownTimeoutError);
    release();
    await expect(active).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('bounds completed run id replay protection while retaining active ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-run-bounded-'));
    dirs.push(dir);
    const bus = createEventBus(dir);
    let sessionId = 'home';
    const agent = {
      getSessionId: () => sessionId,
      setSessionId: (id: string) => { sessionId = id; },
    };
    const coordinator = createSessionRunCoordinator({ agent, bus, completedRunIdLimit: 2 });
    for (const runId of ['bounded-a', 'bounded-b', 'bounded-c']) {
      await coordinator.execute({ context: ctx(runId, 'session'), operation: async () => success, classify: normalizeAgentRunStatus });
    }

    expect(coordinator.has('bounded-a')).toBe(false);
    expect(coordinator.has('bounded-b')).toBe(true);
    expect(coordinator.has('bounded-c')).toBe(true);
    await expect(coordinator.execute({
      context: ctx('bounded-a', 'session'),
      operation: async () => success,
      classify: normalizeAgentRunStatus,
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(() => coordinator.execute({
      context: ctx('bounded-c', 'session'),
      operation: async () => success,
      classify: normalizeAgentRunStatus,
    })).toThrow(RunIdentityConflictError);
  });

  it('rejects reused run ids synchronously without producing a second final event', async () => {
    const h = harness();
    const context = ctx('run-once', 'session-a');
    await h.coordinator.execute({ context, operation: async () => success, classify: normalizeAgentRunStatus });
    expect(() => h.coordinator.execute({
      context: createRunContext({ runId: context.runId, correlationId: 'corr-other', sessionId: 'session-b' }),
      operation: async () => success,
      classify: normalizeAgentRunStatus,
    })).toThrow(RunIdentityConflictError);
    expect(h.bus.history().filter(event => event.type === 'run.final' && event.runId === context.runId)).toHaveLength(1);
  });
});

describe('Run protocol', () => {
  it('aggregates nested final statuses conservatively', () => {
    expect(aggregateRunFinalStatuses([])).toBe('inconclusive');
    expect(aggregateRunFinalStatuses(['succeeded', 'succeeded'])).toBe('succeeded');
    expect(aggregateRunFinalStatuses(['succeeded', 'failed'])).toBe('incomplete');
    expect(aggregateRunFinalStatuses(['blocked', 'blocked'])).toBe('blocked');
    expect(aggregateRunFinalStatuses(['inconclusive', 'inconclusive'])).toBe('inconclusive');
    expect(aggregateRunFinalStatuses(['blocked', 'failed'])).toBe('failed');
    expect(aggregateRunFinalStatuses(['succeeded', 'cancelled'])).toBe('cancelled');
  });

  it('preserves all six final statuses and validates immutable identifiers', () => {
    for (const status of RUN_FINAL_STATUSES) {
      expect(normalizeAgentRunStatus({ ok: status === 'succeeded', status })).toBe(status);
    }
    const context = createRunContext({ runId: 'run-1', correlationId: 'corr:1', sessionId: 'session.one' });
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => createRunContext({ runId: 'bad id', sessionId: 'session' })).toThrow('RUN_ID_INVALID');
    expect(() => createRunContext({ runId: 'run', correlationId: '', sessionId: 'session' })).toThrow('CORRELATION_ID_INVALID');
    expect(() => createRunContext({ runId: 'run', sessionId: '../session' })).toThrow('SESSION_ID_INVALID');
    for (const sessionId of ['.', '..', 'CON', 'nul.txt', 'a:b', 'session.', 'SessionA']) {
      expect(() => createRunContext({ runId: 'run', sessionId })).toThrow('SESSION_ID_INVALID');
    }
    expect(createRunContext({ runId: 'run', sessionId: 'session-safe_1' }).sessionId).toBe('session-safe_1');
  });
});
