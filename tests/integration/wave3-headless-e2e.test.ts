// tests/integration/wave3-headless-e2e.test.ts — W3-11：headless 全链路（事件 → 纯投影 → 完成终态 → 传输三元组 → 证据闭合）
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCliFrontend } from '../../src/bootstrap/createCliFrontend.js';
import { createWireFrontend } from '../../src/bootstrap/createWireFrontend.js';
import { createHttpFrontend } from '../../src/bootstrap/createHttpFrontend.js';
import { createCommandBus } from '../../src/app/CommandBus.js';
import { createBuiltinVerifierRegistry } from '../../src/application/quality/verifierRegistry.js';
import { EvidenceService } from '../../src/application/quality/evidenceService.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { BUILTIN_VERIFIER_DESCRIPTORS } from '../../src/domain/quality/verifier.js';
import type { GatewayEvent } from '../../src/protocol/events.js';
import type { GatewayPort } from '../../src/protocol/gateway.js';
import { completionTransport } from '../../src/protocol/completionTransport.js';

const envelope = (type: string, runId: string, payload: unknown): GatewayEvent => ({
  schemaVersion: 1, type, producer: 'gateway', timestamp: '2026-08-13T00:00:00.000Z', locale: 'zh-CN',
  source: 'kernel', capabilities: [], policySnapshotId: 'p', correlationId: 'c',
  sensitivity: 'internal', retention: 'session', sessionId: 's', runId, payload,
});

describe('wave3 headless e2e', () => {
  it('runs the full pipeline: events → projection → completion → transport triple → closed evidence', async () => {
    const handlers = new Set<(event: GatewayEvent) => void>();
    const port: GatewayPort = {
      request: vi.fn(async () => ({ ok: true as const, value: undefined })),
      subscribe: handler => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    };
    const fronts = [createCliFrontend(port), createWireFrontend(port), createHttpFrontend(port)];
    const emit = (event: GatewayEvent) => { for (const handler of [...handlers]) handler(event); };

    emit(envelope('run.started', 'r1', {}));
    emit(envelope('run.completed', 'r1', { status: 'failed', reasons: ['criterion failed'] }));
    for (const front of fronts) {
      expect(front.snapshot().runs).toMatchObject({ r1: { status: 'failed' } });
      expect(front.complete('failed', { wireFinal: 'failed' })).toMatchObject({ ok: true, value: 'failed' });
      const propagated = front.propagate('failed');
      expect(propagated.ok && propagated.value).toEqual(completionTransport.failed);
    }

    const bus = createCommandBus();
    bus.register('/status', () => 'ok');
    expect(await bus.execute('/status')).toMatchObject({ ok: true, completionStatus: 'succeeded' });

    const root = await mkdtemp(join(tmpdir(), 'wxnodus-e2e-'));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const evidence = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const descriptor = BUILTIN_VERIFIER_DESCRIPTORS['process.readiness'];
      const request = {
        id: 'v1', runId: 'run-e2e',
        objective: { id: 'o1', description: 'e2e' },
        criterion: { id: 'c1', description: 'ready', required: true, expected: true },
        verifierId: 'process.readiness' as const,
        input: Object.fromEntries(descriptor.requiredInputKeys.map(key => [key, true])),
        timeoutMs: 500,
        context: {
          sessionId: 's', correlationId: 'c', traceId: 't',
          environmentSnapshotId: 'e', environmentSha256: 'a'.repeat(64),
          capabilitySnapshotId: 'c', capabilitySha256: 'b'.repeat(64),
          policySnapshotId: 'p', policySha256: 'c'.repeat(64), policyDecisionId: 'd',
          artifactId: 'a', artifactSha256: 'f'.repeat(64),
        },
        execution: {
          command: { executable: 'node', argv: ['s.js'], cwd: 'C:/w', normalized: 'node s.js', timeoutMs: 500 },
          exit: { code: 0, signal: null, timedOut: false, aborted: false },
          stdout: { attachmentId: 'stdout-1', bytes: Buffer.from('ok') },
          stderr: { attachmentId: 'stderr-1', bytes: Buffer.alloc(0) },
        },
      };
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      const closed = await evidence.close(request, verified.value);
      expect(closed.ok).toBe(true);
      expect(await store.verifyIntegrity('run-e2e')).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
