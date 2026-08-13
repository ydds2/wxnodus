// tests/integration/buildEvidenceDecision.test.ts — W3-08：构建证据 → 完成判定（篡改阻断 Gate G；终态码诚实）
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildVerifierDecision, classifyBuildVerifierOutcome } from '../../src/application/quality/buildVerifiers.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { EvidenceService } from '../../src/application/quality/evidenceService.js';
import { createBuiltinVerifierRegistry } from '../../src/application/quality/verifierRegistry.js';
import { BUILTIN_VERIFIER_DESCRIPTORS } from '../../src/domain/quality/verifier.js';
import type { VerificationRequest } from '../../src/domain/quality/verifier.js';

const requestFor = (verifierId: 'process.readiness', attempt: string): VerificationRequest => ({
  id: `v-${attempt}`,
  runId: 'run-build-evidence',
  objective: { id: 'o1', description: 'build evidence decision' },
  criterion: { id: `c-${attempt}`, description: 'ready', required: true, expected: true },
  verifierId,
  input: Object.fromEntries(BUILTIN_VERIFIER_DESCRIPTORS[verifierId].requiredInputKeys.map(key => [key, true])),
  timeoutMs: 500,
  context: {
    sessionId: 's1', correlationId: `corr-${attempt}`, traceId: 't1',
    environmentSnapshotId: 'env-1', environmentSha256: 'a'.repeat(64),
    capabilitySnapshotId: 'cap-1', capabilitySha256: 'b'.repeat(64),
    policySnapshotId: 'p1', policySha256: 'c'.repeat(64), policyDecisionId: 'd1',
    artifactId: 'artifact-1', artifactSha256: 'f'.repeat(64),
  },
  execution: {
    command: { executable: 'node', argv: ['server.js'], cwd: 'C:/workspace', normalized: 'node server.js', timeoutMs: 500 },
    exit: { code: 0, signal: null, timedOut: false, aborted: false },
    stdout: { attachmentId: `stdout-${attempt}`, bytes: Buffer.from('listening', 'utf8') },
    stderr: { attachmentId: `stderr-${attempt}`, bytes: Buffer.alloc(0) },
  },
});

describe('build evidence decision', () => {
  it('closes build verification evidence into a tamper-evident bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-evidence-'));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const evidence = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const request = requestFor('process.readiness', '1');
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      const closed = await evidence.close(request, verified.value);
      expect(closed.ok).toBe(true);
      const integrity = await store.verifyIntegrity('run-build-evidence');
      expect(integrity.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks the completion gate when evidence is tampered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-build-tamper-'));
    try {
      const store = new FileEvidenceStore(root);
      const registry = createBuiltinVerifierRegistry({ run: async () => ({ kind: 'pass', observed: true, authoritySource: 'process-supervisor', sourceRecordId: 'p1' }) });
      const evidence = new EvidenceService({ appendClosed: store.appendClosed.bind(store) });
      const request = requestFor('process.readiness', '1');
      const verified = await registry.verify(request, AbortSignal.timeout(1_000));
      if (!verified.ok) return;
      const closed = await evidence.close(request, verified.value);
      expect(closed.ok).toBe(true);
      const manifestPath = join(root, 'run-build-evidence', 'manifest.json');
      const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8')) as { entries: Array<{ path: string }> };
      const attachment = manifest.entries.find(entry => entry.path.startsWith('attachments/'))!;
      await writeFile(join(root, 'run-build-evidence', attachment.path), 'tampered');
      await expect(store.verifyIntegrity('run-build-evidence')).resolves.toMatchObject({
        ok: false,
        error: { code: 'EVIDENCE_INTEGRITY_FAILED' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never reports succeeded for failed build verification outcomes', () => {
    const outcomes = [
      classifyBuildVerifierOutcome({ status: 'failed' }),
      classifyBuildVerifierOutcome({ status: 'inconclusive', kind: 'crash' }),
      classifyBuildVerifierOutcome({ status: 'inconclusive', kind: 'test-script-missing' }),
    ];
    for (const outcome of outcomes) expect(outcome.status).not.toBe('succeeded');
    expect(buildVerifierDecision([{ status: 'passed' }, { status: 'inconclusive', kind: 'crash' }]).status).toBe('inconclusive');
  });
});
