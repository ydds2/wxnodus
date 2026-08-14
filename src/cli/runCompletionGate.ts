// src/cli/runCompletionGate.ts — Gate G-W3 薄 authority adapter：只做 orchestration，绝不含本地完成算法。
// 输入：--run <runId> [--evidence-root <path>]
//   <root>/<runId>/completion-input.json  → { binding: ReviewBinding, attestation: ReviewerAttestation }
//   <root>/reviewer-trust.json            → 可信 reviewer key 配置（release config，绝不信 bundle 自带）
// 输出：owned CompletionDecisionReceipt 的 decision JSON；bootstrap/验证失败只输出错误 envelope，退出码 blocked。
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompletionCoordinator } from '../application/quality/completionCoordinator.js';
import { CompletionGate, type CompletionGateInput } from '../domain/quality/completionGate.js';
import {
  normalizeReviewBinding,
  normalizeReviewerAttestation,
  ReviewerAttestationVerifier,
  type ReviewerKeyPolicy,
  type ReviewerTrustPolicy,
} from '../domain/quality/review.js';
import { FileEvidenceStore } from '../infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../infrastructure/quality/fileReviewNonceStore.js';
import { processExitForCompletion } from '../protocol/completionTransport.js';

const blocked = (code: string): number => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
  return processExitForCompletion('blocked');
};

function parseReviewerKeys(raw: unknown): ReviewerTrustPolicy {
  const entries = Array.isArray(raw) ? raw : [];
  const keys: ReviewerKeyPolicy[] = entries.map(entry => {
    const item = entry as Record<string, unknown>;
    const publicKeyPem = String(item.publicKeyPem ?? '');
    return {
      issuer: String(item.issuer ?? ''),
      keyId: String(item.keyId ?? ''),
      algorithm: 'Ed25519' as const,
      publicKey: createPublicKey(publicKeyPem),
      reviewerActorIds: Array.isArray(item.reviewerActorIds) ? item.reviewerActorIds.map(String) : [],
      activeFrom: String(item.activeFrom ?? ''),
      activeUntil: String(item.activeUntil ?? ''),
      ...(typeof item.revokedAt === 'string' ? { revokedAt: item.revokedAt } : {}),
      maxAgeMs: Number(item.maxAgeMs),
      maxClockSkewMs: Number(item.maxClockSkewMs),
    };
  });
  return {
    resolve: (issuer, keyId) => keys.find(key => key.issuer === issuer && key.keyId === keyId),
  };
}

export async function runCompletionGate(argv: string[]): Promise<number> {
  const runFlag = argv.indexOf('--run');
  const runId = runFlag >= 0 ? argv[runFlag + 1] : undefined;
  if (!runId) {
    process.stderr.write('usage: run-completion-gate --run <uuid> [--evidence-root <path>]\n');
    return processExitForCompletion('incomplete');
  }
  const rootFlag = argv.indexOf('--evidence-root');
  const evidenceRoot = resolve(rootFlag >= 0 && argv[rootFlag + 1] ? argv[rootFlag + 1]! : 'artifacts/release-evidence');
  const runDir = join(evidenceRoot, runId);

  const store = new FileEvidenceStore(evidenceRoot);

  // 1) run bundle 完整性：manifest 根摘要重算 + 全条目实测（不信任落盘 hash）
  const integrity = await store.verifyIntegrity(runId);
  if (!integrity.ok) return blocked(integrity.error.code);

  // 2) persisted completion input（binding + attestation）——缺失即 blocked，绝不回退本地算法
  let binding;
  let attestation;
  try {
    const raw = JSON.parse(await readFile(join(runDir, 'completion-input.json'), 'utf8')) as { binding?: unknown; attestation?: unknown };
    binding = normalizeReviewBinding(raw.binding);
    attestation = normalizeReviewerAttestation(raw.attestation);
  } catch {
    return blocked('COMPLETION_INPUT_MISSING');
  }

  // 3) trusted reviewer key 配置（release config，不是 attestation 旁的不可信输入）
  let policy: ReviewerTrustPolicy;
  try {
    policy = parseReviewerKeys(JSON.parse(await readFile(join(evidenceRoot, 'reviewer-trust.json'), 'utf8')));
  } catch {
    return blocked('REVIEWER_TRUST_MISSING');
  }

  // 4) 逐个 readVerifiedClosed：receipt 只能由本 store 实例签发（WeakSet ownership）
  const evidenceReceipts = [];
  for (const ref of binding.evidence) {
    const receipt = await store.readVerifiedClosed(runId, ref);
    if (!receipt.ok) return blocked(receipt.error.code);
    evidenceReceipts.push(receipt.value);
  }

  // 5) reviewer 验证（nonce 消耗 + 签名 + 时效窗口）
  const verifier = new ReviewerAttestationVerifier(policy, new FileReviewNonceStore(join(runDir, 'review-nonces')));
  const review = await verifier.verify(attestation, binding);
  if (!review.ok) return blocked(review.error.code);

  // 6) 唯一 authority 决定；只有 owned succeeded receipt 才 exit 0
  const coordinator = new CompletionCoordinator(new CompletionGate(store, verifier));
  const input: CompletionGateInput = { ...binding, evidence: evidenceReceipts, review: review.value };
  const result = coordinator.decide(input);
  if (!result.ok) return blocked(result.error.code);
  if (!coordinator.owns(result.value)) return blocked('COMPLETION_RECEIPT_UNTRUSTED');
  process.stdout.write(`${JSON.stringify(result.value.decision)}\n`);
  return processExitForCompletion(result.value.decision.status);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runCompletionGate(process.argv.slice(2));
}
