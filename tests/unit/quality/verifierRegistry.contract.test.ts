import { describe, expect, it } from 'vitest';
import {
  BUILTIN_VERIFIER_IDS,
  BUILTIN_VERIFIER_DESCRIPTORS,
  type BuiltinVerifierId,
  type ProbeOutcome,
  type VerificationRequest,
} from '../../../src/domain/quality/verifier.js';
import { createBuiltinVerifierRegistry } from '../../../src/application/quality/verifierRegistry.js';
import { EvidenceService } from '../../../src/application/quality/evidenceService.js';

const requestFor = (verifierId: BuiltinVerifierId, attempt: string): VerificationRequest => ({
  id: `verification-${verifierId}-${attempt}`,
  runId: 'run-w3-01',
  objective: { id: 'objective-1', description: 'close the verifier contract' },
  criterion: {
    id: `criterion-${verifierId}`,
    description: `verify ${verifierId}`,
    required: true,
    expected: true,
  },
  verifierId,
  input: Object.fromEntries(BUILTIN_VERIFIER_DESCRIPTORS[verifierId].requiredInputKeys.map(key => [key, true])),
  timeoutMs: 250,
  context: {
    sessionId: 'session-1',
    correlationId: `correlation-${verifierId}-${attempt}`,
    traceId: 'trace-1',
    environmentSnapshotId: 'env-1',
    environmentSha256: 'a'.repeat(64),
    capabilitySnapshotId: 'cap-1',
    capabilitySha256: 'b'.repeat(64),
    policySnapshotId: 'policy-1',
    policySha256: 'c'.repeat(64),
    policyDecisionId: 'decision-1',
    artifactId: 'artifact-1',
    artifactSha256: 'f'.repeat(64),
  },
  execution: {
    command: {
      executable: 'builtin-verifier',
      argv: [verifierId],
      cwd: 'C:/workspace',
      normalized: `builtin-verifier ${verifierId}`,
      timeoutMs: 250,
    },
    exit: { code: 0, signal: null, timedOut: false, aborted: false },
    stdout: { attachmentId: `stdout-${verifierId}`, bytes: Buffer.from(`stdout:${verifierId}`, 'utf8') },
    stderr: { attachmentId: `stderr-${verifierId}`, bytes: Buffer.alloc(0) },
  },
});

const makeStore = () => {
  const records: unknown[] = [];
  const attachments = new Map<string, Buffer>();
  return {
    records,
    attachments,
    async appendClosed(record: unknown, pending: Array<{ attachmentId: string; bytes: Buffer }>) {
      records.push(record);
      for (const item of pending) attachments.set(item.attachmentId, item.bytes);
      return { ok: true as const, value: { evidenceId: (record as { id: string }).id } };
    },
  };
};

describe.each(BUILTIN_VERIFIER_IDS)('%s verifier closure', verifierId => {
  it('has a stable descriptor and closes pass, fail, and crash through an EvidenceRecord', async () => {
    const descriptor = BUILTIN_VERIFIER_DESCRIPTORS[verifierId];
    expect(descriptor).toMatchObject({ id: verifierId, version: '1.0.0' });
    expect(descriptor.requiredInputKeys.length).toBeGreaterThan(0);
    expect(descriptor.requiredCapabilities.length).toBeGreaterThan(0);
    const outcomes: ProbeOutcome[] = [
      { kind: 'pass', observed: true, authoritySource: descriptor.authoritySource, sourceRecordId: 'source-pass' },
      { kind: 'fail', observed: false, authoritySource: descriptor.authoritySource, sourceRecordId: 'source-fail' },
      { kind: 'crash', error: new Error('probe exploded'), authoritySource: descriptor.authoritySource, sourceRecordId: 'source-crash' },
    ];
    const probe = { run: async () => outcomes.shift()! };
    const registry = createBuiltinVerifierRegistry(probe);
    const store = makeStore();
    const evidence = new EvidenceService(store);

    const passRequest = requestFor(verifierId, 'pass');
    const passed = await registry.verify(passRequest, AbortSignal.timeout(1_000));
    expect(passed.ok && passed.value.status).toBe('passed');
    const passClose = passed.ok ? await evidence.close(passRequest, passed.value) : passed;
    expect(passClose.ok).toBe(true);

    const failRequest = requestFor(verifierId, 'fail');
    const failed = await registry.verify(failRequest, AbortSignal.timeout(1_000));
    expect(failed.ok && failed.value.status).toBe('failed');
    expect(failed.ok && failed.value.failureCode).toBe('VERIFIER_ASSERTION_FAILED');
    const failClose = failed.ok ? await evidence.close(failRequest, failed.value) : failed;
    expect(failClose.ok).toBe(true);

    const crashRequest = requestFor(verifierId, 'crash');
    const crashed = await registry.verify(crashRequest, AbortSignal.timeout(1_000));
    expect(crashed.ok && crashed.value.status).toBe('inconclusive');
    expect(crashed.ok && crashed.value.failureCode).toBe('VERIFIER_CRASH');
    const crashClose = crashed.ok ? await evidence.close(crashRequest, crashed.value) : crashed;
    expect(crashClose.ok).toBe(true);

    expect(store.records).toHaveLength(3);
    for (const value of store.records) {
      const record = value as Record<string, unknown>;
      expect(record).toMatchObject({
        schemaVersion: 1,
        runId: 'run-w3-01',
        objective: { id: 'objective-1' },
        environment: { snapshotId: 'env-1' },
        capability: { snapshotId: 'cap-1' },
        policy: { snapshotId: 'policy-1' },
        correlation: { traceId: 'trace-1' },
        lineage: { sessionId: 'session-1' },
      });
      expect((record.verifier as { id: string }).id).toBe(verifierId);
      expect(Array.isArray(record.criteria)).toBe(true);
      expect(Object.hasOwn(record, 'command')).toBe(true);
      expect(Object.hasOwn(record, 'exit')).toBe(true);
      expect(Object.hasOwn(record, 'stdout')).toBe(true);
      expect(Object.hasOwn(record, 'stderr')).toBe(true);
      const stdout = record.stdout as { attachmentId: string; path: string; sha256: string; bytes: number };
      const stderr = record.stderr as { attachmentId: string; path: string; sha256: string; bytes: number };
      expect(stdout).toMatchObject({ path: `attachments/${stdout.attachmentId}` });
      expect(stderr).toMatchObject({ path: `attachments/${stderr.attachmentId}` });
      expect(stdout.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(stderr.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.closure).toMatchObject({ status: 'closed' });
      expect(new Set((record.closure as { attachmentIds: string[] }).attachmentIds).size).toBe(2);
      // W1-09 合同：authority 是审计元数据，不含 trusted 信任字段
      expect(Object.hasOwn(record.authority as object, 'trusted')).toBe(false);
    }
    const ids = store.records.map(value => (value as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

it('rejects a verifier result that conflicts with the authoritative audit source', async () => {
  const store = makeStore();
  const evidence = new EvidenceService(store);
  const request = requestFor('command.exit-code', 'authority-conflict');
  const result = await evidence.close(request, {
    verificationId: request.id,
    status: 'passed',
    observed: { exitCode: 0 },
    evidenceIds: [],
    authority: {
      source: 'process-supervisor',
      sourceRecordId: 'process-9',
      sourceStatus: 'failed',
      trusted: true,
    },
  });

  expect(result).toMatchObject({
    ok: false,
    error: { code: 'EVIDENCE_AUDIT_SOURCE_CONFLICT' },
  });
  expect(store.records).toHaveLength(0);
});
