// scripts/drill-wave3-recovery.mjs — Wave 3 当前候选 recovery drill（Gate C-W3）：
// 候选 artifact 重读绑定 → 每个 W0-W2 descriptor（locked hash）执行 → maxRtoMs 强制 → 原子写 migrations/c-w3-receipt.json
// 缺失当前 receipt → WAVE3_CURRENT_MIGRATION_RECEIPT_MISSING；绑定漂移 → WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH；失败 → WAVE3_RECOVERY_DRILL_FAILED
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runWave3RecoveryDescriptors } from './wave3RecoveryDescriptors.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const fail = (code, stage, cause) => ({ ok: false, error: { code, stage, cause } });

export function runWave3RecoveryDrill(options) {
  const {
    root, runId, candidateCommit, artifactId, artifactSha256, environmentSnapshotId,
    descriptors, maxRtoMs = 10_000,
  } = options;
  if (!runId || !candidateCommit || !artifactId || !artifactSha256 || !environmentSnapshotId) {
    return fail('WAVE3_CURRENT_MIGRATION_RECEIPT_MISSING', 'binding', 'runId/candidateCommit/artifact/environment must all be bound');
  }
  // 1. 候选 artifact 重读（拒绝 hash 漂移）
  const artifactPath = join(root, 'candidate-artifact.bin');
  if (!existsSync(artifactPath)) return fail('WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH', 'artifact', `missing ${artifactPath}`);
  if (sha256(readFileSync(artifactPath)) !== artifactSha256) return fail('WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH', 'artifact', 'hash drift on reread');

  // 2. 每个 descriptor：locked hash 校验 → drill → maxRtoMs 强制
  const stages = [];
  for (const descriptor of descriptors) {
    if (typeof descriptor.expectedHash === 'string' && descriptor.expectedHash !== descriptor.hash) {
      return fail('WAVE3_RECOVERY_DRILL_FAILED', `${descriptor.id}:descriptor-hash`, 'locked descriptor hash mismatch');
    }
    const startedAt = Date.now();
    let result;
    try {
      result = descriptor.drill({ root });
    } catch (error) {
      result = { ok: false, stage: 'crash', cause: String(error?.message ?? error) };
    }
    const rtoMs = Date.now() - startedAt;
    stages.push({ descriptorId: descriptor.id, strategy: descriptor.strategy, ok: result.ok, stage: result.stage ?? 'ok', rtoMs, evidenceId: result.evidenceId ?? null });
    if (rtoMs > maxRtoMs) return fail('WAVE3_RECOVERY_DRILL_FAILED', `${descriptor.id}:max-rto`, `${rtoMs}ms > ${maxRtoMs}ms`);
    if (!result.ok) return fail('WAVE3_RECOVERY_DRILL_FAILED', `${descriptor.id}:${result.stage ?? 'unknown'}`, result.cause);
  }

  // 3. 不可变/闭合 receipt（原子写）
  const receipt = {
    schemaVersion: 1,
    receiptId: `c-w3-${runId}`,
    runId,
    candidateCommit,
    artifact: { id: artifactId, sha256: artifactSha256 },
    environmentSnapshotId,
    descriptorHashes: Object.fromEntries(descriptors.map(descriptor => [descriptor.id, descriptor.hash])),
    backupHashes: Object.fromEntries(descriptors.map(descriptor => [descriptor.id, descriptor.backupHash ?? null])),
    stages,
    closure: { status: 'closed' },
    createdAt: new Date().toISOString(),
  };
  const receiptDir = join(root, 'migrations');
  mkdirSync(receiptDir, { recursive: true });
  const receiptPath = join(receiptDir, 'c-w3-receipt.json');
  const tempPath = `${receiptPath}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(receipt, null, 2), 'utf8');
  renameSync(tempPath, receiptPath);
  return { ok: true, receiptPath, receipt };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const args = process.argv.slice(2);
  const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const root = resolve(process.env.WXNODUS_ROOT ?? process.cwd());
  const result = runWave3RecoveryDrill({
    root,
    runId: flag('--run') ?? 'wave3-drill',
    candidateCommit: flag('--candidate-commit') ?? '',
    artifactId: flag('--artifact-id') ?? '',
    artifactSha256: flag('--artifact-sha256') ?? '',
    environmentSnapshotId: flag('--environment-snapshot') ?? '',
    descriptors: runWave3RecoveryDescriptors(root),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}
