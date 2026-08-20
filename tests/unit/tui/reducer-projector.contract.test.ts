// tests/unit/tui/reducer-projector.contract.test.ts — W3-02 Step 1：纯展示层契约（确定性/无副作用/无 React）
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '../../../src/protocol/events.js';
import { initialTuiState, reduceTui } from '../../../src/presentation/tui/state/reducer.js';
import { projectGatewayEvent } from '../../../src/presentation/tui/state/projector.js';

const envelope = (type: string, runId: string, payload: unknown): GatewayEvent => ({
  schemaVersion: 1,
  type,
  producer: 'gateway',
  timestamp: '2026-08-13T00:00:00.000Z',
  locale: 'zh-CN',
  source: 'kernel',
  capabilities: [],
  policySnapshotId: 'policy-1',
  correlationId: 'c1',
  sensitivity: 'internal',
  retention: 'session',
  sessionId: 's1',
  runId,
  payload,
});

const events = [
  envelope('run.started', 'r1', {}),
  envelope('run.completed', 'r1', { status: 'failed', reasons: ['criterion failed'] }),
];

describe('pure TUI projection', () => {
  it('produces the same state for the same event sequence without timers, RPC, fs, or mutation', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const apply = () => events.flatMap(projectGatewayEvent).reduce(reduceTui, initialTuiState());
    const first = apply();
    const second = apply();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ runs: { r1: { status: 'failed' } } });
    expect(timer).not.toHaveBeenCalled();
    expect(initialTuiState()).toEqual({ runs: {}, effects: [], lastError: null });
  });

  it('rejects unsupported events with a stable action instead of throwing or guessing', () => {
    expect(projectGatewayEvent({ ...events[0], type: 'unknown.event' })).toEqual([{
      type: 'projection.failed',
      code: 'TUI_EVENT_UNSUPPORTED',
      eventType: 'unknown.event',
    }]);
  });

  it('keeps headless bootstrap files free of React and Ink imports', async () => {
    for (const path of [
      'src/bootstrap/createCliFrontend.ts',
      'src/bootstrap/createWireFrontend.ts',
      'src/bootstrap/createHttpFrontend.ts',
    ]) {
      const source = await readFile(path, 'utf8');
      expect(source).not.toMatch(/from ['"](?:react|ink|@wxnodus\/ink)/);
    }
  });
});
