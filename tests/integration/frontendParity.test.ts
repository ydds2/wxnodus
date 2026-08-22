// tests/integration/frontendParity.test.ts — W3-02：四个入口前端对同一事件序列产出同一纯状态、同一传播三元组
// parity 由构造保证（共享 createFrontendBase）；漂移上报 FRONTEND_COMPLETION_MISMATCH / FRONTEND_FAILURE_PROPAGATION_MISMATCH
import { describe, expect, it, vi } from 'vitest';
import { createCliFrontend } from '../../src/bootstrap/createCliFrontend.js';
import { createHttpFrontend } from '../../src/bootstrap/createHttpFrontend.js';
import { createWireFrontend } from '../../src/bootstrap/createWireFrontend.js';
import { completionTransport } from '../../src/protocol/completionTransport.js';
import type { GatewayEvent } from '../../src/protocol/events.js';
import type { GatewayPort } from '../../src/protocol/gateway.js';
import { RUN_FINAL_STATUSES } from '../../src/protocol/runs.js';
import type { TuiFrontend } from '../../src/presentation/tui/frontend.js';

const envelope = (type: string, runId: string, payload: unknown): GatewayEvent => ({
  schemaVersion: 1, type, producer: 'gateway', timestamp: '2026-08-13T00:00:00.000Z', locale: 'zh-CN',
  source: 'kernel', capabilities: [], policySnapshotId: 'policy-1', correlationId: 'c1',
  sensitivity: 'internal', retention: 'session', sessionId: 's1', runId, payload,
});

function makeGateway(events: GatewayEvent[]) {
  const handlers = new Set<(event: GatewayEvent) => void>();
  const port = {
    request: vi.fn(async (_method: string, _params: unknown) => ({ ok: true as const, value: undefined })),
    subscribe: (handler: (event: GatewayEvent) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
  } as GatewayPort;
  return { port, emitAll: () => { for (const event of events) for (const handler of [...handlers]) handler(event); } };
}

const factories = { cli: createCliFrontend, wire: createWireFrontend, http: createHttpFrontend };

describe('frontend parity', () => {
  const events = [envelope('run.started', 'r1', {}), envelope('run.completed', 'r1', { status: 'failed', reasons: ['criterion failed'] })];

  it('projects the same run state from the same event sequence on every entry point', () => {
    const { port, emitAll } = makeGateway(events);
    const frontends = Object.fromEntries(Object.entries(factories).map(([kind, factory]) => [kind, factory(port)])) as Record<string, TuiFrontend>;
    emitAll();
    const snapshots = Object.values(frontends).map(frontend => frontend.snapshot());
    for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
    expect(snapshots[0]).toMatchObject({ runs: { r1: { status: 'failed', reasons: ['criterion failed'] } }, lastError: null });
    expect(new Set(Object.values(frontends).map(frontend => frontend.kind))).toEqual(new Set(['cli', 'wire', 'http']));
  });

  it('propagates the exact shared transport triple for every run final status on every entry point', () => {
    const { port } = makeGateway([]);
    const frontends = Object.values(factories).map(factory => factory(port));
    for (const status of RUN_FINAL_STATUSES) {
      for (const frontend of frontends) {
        expect(frontend.propagate(status)).toMatchObject({
          ok: true,
          value: { processExit: completionTransport[status].processExit, httpStatus: completionTransport[status].httpStatus, wireFinal: completionTransport[status].wireFinal },
        });
      }
    }
  });

  it('rejects a frontend-reported final that drifts from the shared table on every entry point', () => {
    const { port } = makeGateway([]);
    for (const factory of Object.values(factories)) {
      const frontend = factory(port);
      expect(frontend.complete('failed', { wireFinal: 'succeeded' })).toMatchObject({
        ok: false,
        error: { code: 'FRONTEND_COMPLETION_MISMATCH' },
      });
      expect(frontend.complete('succeeded', { wireFinal: 'succeeded' })).toMatchObject({ ok: true, value: 'succeeded' });
      const blocked = frontend.propagate('blocked');
      expect(blocked.ok && blocked.value.processExit).toBe(2);
    }
  });

  it('stops projecting after dispose', () => {
    const { port, emitAll } = makeGateway(events);
    const frontend = createCliFrontend(port);
    frontend.dispose();
    emitAll();
    expect(frontend.snapshot()).toEqual({ runs: {}, effects: [], lastError: null });
  });
});
