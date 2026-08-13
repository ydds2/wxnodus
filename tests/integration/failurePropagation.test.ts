// tests/integration/failurePropagation.test.ts — W3-01 Step 5：完成终态 → 传输层全入口口径一致
// 任何 failure 都不允许藏在 process exit 0 或 HTTP 200 后面；三个入口共享同一张 completionTransport 表。
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertCompletionPropagation,
  completionTransport,
  httpStatusForCompletion,
  processExitForCompletion,
  wireFinalForCompletion,
} from '../../src/protocol/completionTransport.js';
import { RUN_FINAL_STATUSES } from '../../src/protocol/runs.js';
import { createCommandBus } from '../../src/app/CommandBus.js';
import { gateCompletionStatus, gateProcessExit } from '../../src/build/gate.js';
import { evidenceCompletionStatus } from '../../src/build/evidence.js';

describe('completion transport propagation', () => {
  it('fixes the exact shared mapping for every run final status', () => {
    expect(completionTransport).toEqual({
      succeeded: { processExit: 0, httpStatus: 200, wireFinal: 'succeeded' },
      failed: { processExit: 1, httpStatus: 422, wireFinal: 'failed' },
      blocked: { processExit: 2, httpStatus: 409, wireFinal: 'blocked' },
      incomplete: { processExit: 3, httpStatus: 424, wireFinal: 'incomplete' },
      inconclusive: { processExit: 4, httpStatus: 503, wireFinal: 'inconclusive' },
      cancelled: { processExit: 130, httpStatus: 499, wireFinal: 'cancelled' },
    });
    for (const status of RUN_FINAL_STATUSES) {
      expect(processExitForCompletion(status)).toBe(completionTransport[status].processExit);
      expect(httpStatusForCompletion(status)).toBe(completionTransport[status].httpStatus);
      expect(wireFinalForCompletion(status)).toBe(completionTransport[status].wireFinal);
    }
  });

  it('never hides any failure behind process exit 0 or HTTP 200', () => {
    const failures = RUN_FINAL_STATUSES.filter(status => status !== 'succeeded');
    for (const status of failures) {
      expect(processExitForCompletion(status)).not.toBe(0);
      expect(httpStatusForCompletion(status)).not.toBe(200);
    }
    expect(new Set(RUN_FINAL_STATUSES.map(processExitForCompletion)).size).toBe(RUN_FINAL_STATUSES.length);
  });

  it('fails closed with FRONTEND_FAILURE_PROPAGATION_MISMATCH on drift', () => {
    expect(assertCompletionPropagation('failed', { processExit: 0, httpStatus: 200, wireFinal: 'failed' })).toMatchObject({
      ok: false,
      error: { code: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH' },
    });
    expect(assertCompletionPropagation('succeeded', { httpStatus: 500 })).toMatchObject({
      ok: false,
      error: { code: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH' },
    });
    expect(assertCompletionPropagation('bogus-status', {})).toMatchObject({
      ok: false,
      error: { code: 'FRONTEND_FAILURE_PROPAGATION_MISMATCH' },
    });
    expect(assertCompletionPropagation('cancelled', { processExit: 130, httpStatus: 499, wireFinal: 'cancelled' })).toMatchObject({ ok: true });
  });

  it('projects command, gate, and evidence results through the shared mapping', async () => {
    const bus = createCommandBus();
    bus.register('/status', () => 'ok');
    expect(await bus.execute('/status')).toMatchObject({ ok: true, completionStatus: 'succeeded' });
    expect(await bus.execute('/unknown')).toMatchObject({ ok: false, completionStatus: 'failed' });
    expect(await bus.execute('not a command')).toMatchObject({ ok: false, completionStatus: 'failed' });

    expect(gateCompletionStatus({ gates: [], pass: true })).toBe('succeeded');
    expect(gateProcessExit({ gates: [], pass: false })).toBe(processExitForCompletion('failed'));
    expect(evidenceCompletionStatus({ status: 'ok', checks: [], port: null, fingerprint: 'x', ts: 0 })).toBe('succeeded');
    expect(evidenceCompletionStatus({ status: 'failed', checks: [], port: null, fingerprint: 'x', ts: 0 })).toBe('failed');
    expect(evidenceCompletionStatus(null)).toBe('inconclusive');
  });

  it('keeps every entry point bound to the shared table instead of local literals', async () => {
    for (const path of ['src/cli/index.ts', 'src/cli/serve.ts', 'src/build/gate.ts']) {
      const source = await readFile(path, 'utf8');
      expect(source).toMatch(/from ['"]\.\.\/protocol\/completionTransport\.js['"]/);
    }
  });
});
