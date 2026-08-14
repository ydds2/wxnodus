// tests/fixtures/file-evidence-store-writer.ts — 跨进程 evidence 写入 fixture：
// 独立进程内构造 store 并 appendClosed 一个闭合记录；stdout 输出结果 JSON，exit 0/1。
// 参数：<evidenceRoot> <runId> <recordId>
import { createHash } from 'node:crypto';
import type { EvidenceRecord } from '../../src/domain/quality/evidence.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const [root, runId, recordId] = process.argv.slice(2);

const stdout = Buffer.from(`stdout-${recordId}`, 'utf8');
const stderr = Buffer.alloc(0);
const stdoutId = `stdout-${recordId}`;
const stderrId = `stderr-${recordId}`;
const artifactSha = 'a'.repeat(64);

const record: EvidenceRecord = {
  id: `record-${recordId}`,
  schemaVersion: 1,
  runId,
  createdAt: new Date().toISOString(),
  objective: { id: `objective-${recordId}`, description: 'cross-process write' },
  criteria: [{ id: `criterion-${recordId}`, description: 'writes closed evidence', required: true, expected: true, observed: true, status: 'passed' }],
  command: { executable: 'node', argv: ['writer.mjs'], cwd: root, normalized: 'node writer.mjs', timeoutMs: 5_000 },
  exit: { code: 0, signal: null, timedOut: false, aborted: false },
  stdout: { attachmentId: stdoutId, relativePath: `attachments/${stdoutId}`, path: `attachments/${stdoutId}`, sha256: digest(stdout), bytes: stdout.byteLength },
  stderr: { attachmentId: stderrId, relativePath: `attachments/${stderrId}`, path: `attachments/${stderrId}`, sha256: digest(stderr), bytes: stderr.byteLength },
  attachments: [],
  closure: { status: 'closed', attachmentIds: [stdoutId, stderrId] },
  artifact: { id: 'artifact-1', sha256: artifactSha },
  environment: { snapshotId: 'env-1', sha256: 'b'.repeat(64), platform: process.platform, arch: process.arch },
  capability: { snapshotId: 'cap-1', sha256: 'c'.repeat(64), requiredIds: ['process.execute'] },
  policy: { snapshotId: 'policy-1', sha256: 'd'.repeat(64), decisionId: 'decision-1' },
  verifier: { id: 'command.exit-code', version: '1.0.0', inputSha256: 'e'.repeat(64), status: 'passed' },
  correlation: { correlationId: `corr-${recordId}`, traceId: `trace-${recordId}` },
  lineage: { sessionId: 'session-1', artifactIds: ['artifact-1'], priorEvidenceIds: [] },
  authority: { source: 'process-supervisor', sourceRecordId: `process-${recordId}`, sourceStatus: 'passed' },
};

async function main() {
  if (!root || !runId || !recordId) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'USAGE' })}\n`);
    return 1;
  }
  const store = new FileEvidenceStore(root);
  const result = await store.appendClosed(record, [
    { attachmentId: stdoutId, bytes: stdout },
    { attachmentId: stderrId, bytes: stderr },
  ]);
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: result.error.code })}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, id: result.value.evidenceId, sha256: result.value.ref.sha256 })}\n`);
  return 0;
}

process.exitCode = await main();
