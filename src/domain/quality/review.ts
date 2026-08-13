// src/domain/quality/review.ts — 独立复核：attestation 是不可信输入，receipt 只能由 verifier 签发
import { createHash, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { ArtifactBinding, EvidenceRef } from './evidence.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface ReviewRun { id: string; runId: string; maker: { actorId: string; contextHash: string }; reviewer: { actorId: string; contextHash: string }; artifact: ArtifactBinding; environment: { snapshotId: string; sha256: string }; policy: { snapshotId: string; sha256: string }; evidence: EvidenceRef[]; status: 'running' | 'completed'; startedAt: string; completedAt?: string; nonce: string }
export interface ReviewBinding { runId: string; artifact: ArtifactBinding; environment: ReviewRun['environment']; policy: ReviewRun['policy']; evidence: EvidenceRef[] }
export interface ReviewerAttestation { schemaVersion: 1; reviewRunId: string; runId: string; outcome: 'passed' | 'failed' | 'inconclusive'; maker: ReviewRun['maker']; reviewer: ReviewRun['reviewer']; artifact: ArtifactBinding; environment: ReviewRun['environment']; policy: ReviewRun['policy']; evidence: EvidenceRef[]; issuer: string; keyId: string; nonce: string; issuedAt: string; expiresAt: string; reviewInputHash: string; signature: string }
export interface VerifiedReviewerAttestationReceipt { readonly attestation: Readonly<ReviewerAttestation>; readonly bindingHash: string; readonly verifiedAt: string }
export interface ReviewNonceStore { consume(input: { issuer: string; keyId: string; nonce: string; reviewInputHash: string; expiresAt: string }): Promise<OperationResult<void>> }
export interface ReviewerKeyPolicy { issuer: string; keyId: string; algorithm: 'Ed25519'; publicKey: KeyObject; reviewerActorIds: readonly string[]; activeFrom: string; activeUntil: string; revokedAt?: string; maxAgeMs: number; maxClockSkewMs: number }
export interface ReviewerTrustPolicy { resolve(issuer: string, keyId: string): ReviewerKeyPolicy | undefined }

const canonical = (value: unknown): string => {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('CANONICAL_VALUE_UNSUPPORTED');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};
const hashCanonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left: unknown, right: unknown) => hashCanonical(left) === hashCanonical(right);
function unsigned(run: ReviewRun, outcome: ReviewerAttestation['outcome'], authority: { issuer: string; keyId: string }, time: { issuedAt: string; expiresAt: string }) {
  return { schemaVersion: 1 as const, reviewRunId: run.id, runId: run.runId, outcome, maker: run.maker, reviewer: run.reviewer,
    artifact: run.artifact, environment: run.environment, policy: run.policy, evidence: run.evidence,
    issuer: authority.issuer, keyId: authority.keyId, nonce: run.nonce, issuedAt: time.issuedAt, expiresAt: time.expiresAt };
}
export async function createReviewerAttestation(run: ReviewRun, outcome: ReviewerAttestation['outcome'], authority: { issuer: string; keyId: string; sign(hash: Uint8Array): Promise<Uint8Array> }, time: { issuedAt: string; expiresAt: string }): Promise<OperationResult<ReviewerAttestation>> {
  try { const body = unsigned(run, outcome, authority, time), reviewInputHash = hashCanonical(body); return ok({ ...body, reviewInputHash, signature: Buffer.from(await authority.sign(Buffer.from(reviewInputHash, 'hex'))).toString('base64') }); }
  catch { return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review signing failed', 'review.attestation.invalid')); }
}
export class ReviewerAttestationVerifier {
  readonly #receipts = new WeakSet<object>();
  constructor(private readonly policy: ReviewerTrustPolicy, private readonly nonces: ReviewNonceStore) {}
  owns(receipt: unknown): receipt is VerifiedReviewerAttestationReceipt { return typeof receipt === 'object' && receipt !== null && this.#receipts.has(receipt); }
  async verify(attestation: ReviewerAttestation, expected: ReviewBinding, now: string): Promise<OperationResult<VerifiedReviewerAttestationReceipt>> {
    try {
      if (attestation.maker.actorId === attestation.reviewer.actorId || attestation.maker.contextHash === attestation.reviewer.contextHash)
        return err(gatewayError('REVIEWER_NOT_INDEPENDENT', 'Reviewer identity and context must both be independent', 'reviewer.notIndependent'));
      if (attestation.runId !== expected.runId || !same(attestation.artifact, expected.artifact) || !same(attestation.environment, expected.environment) || !same(attestation.policy, expected.policy) || !same(attestation.evidence, expected.evidence))
        return err(gatewayError('REVIEW_BINDING_MISMATCH', 'Review binding mismatch', 'review.binding.mismatch'));
      if (!attestation.nonce || new Set(attestation.evidence.map(item => item.id)).size !== attestation.evidence.length)
        return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review input invalid', 'review.attestation.invalid'));
      const key = this.policy.resolve(attestation.issuer, attestation.keyId);
      if (!key) return err(gatewayError('REVIEW_ISSUER_NOT_ALLOWED', 'Review issuer/key unknown', 'review.issuer.notAllowed'));
      if (key.algorithm !== 'Ed25519' || key.revokedAt || !key.reviewerActorIds.includes(attestation.reviewer.actorId))
        return err(gatewayError('REVIEW_KEY_NOT_ALLOWED', 'Review key not allowed', 'review.key.notAllowed'));
      const nowMs = Date.parse(now), issued = Date.parse(attestation.issuedAt), expires = Date.parse(attestation.expiresAt), activeFrom = Date.parse(key.activeFrom), activeUntil = Date.parse(key.activeUntil);
      if (![nowMs, issued, expires, activeFrom, activeUntil].every(Number.isFinite) || expires <= issued || issued > nowMs + key.maxClockSkewMs || expires <= nowMs || nowMs - issued > key.maxAgeMs)
        return err(gatewayError('REVIEW_ATTESTATION_STALE', 'Review attestation stale', 'review.attestation.stale'));
      if (issued < activeFrom || issued >= activeUntil) return err(gatewayError('REVIEW_KEY_NOT_ALLOWED', 'Review key inactive', 'review.key.notAllowed'));
      const body = { schemaVersion: attestation.schemaVersion, reviewRunId: attestation.reviewRunId, runId: attestation.runId, outcome: attestation.outcome,
        maker: attestation.maker, reviewer: attestation.reviewer, artifact: attestation.artifact, environment: attestation.environment, policy: attestation.policy,
        evidence: attestation.evidence, issuer: attestation.issuer, keyId: attestation.keyId, nonce: attestation.nonce, issuedAt: attestation.issuedAt, expiresAt: attestation.expiresAt };
      const reviewInputHash = hashCanonical(body);
      if (reviewInputHash !== attestation.reviewInputHash) return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Canonical review input mismatch', 'review.attestation.invalid'));
      if (!verifySignature(null, Buffer.from(reviewInputHash, 'hex'), key.publicKey, Buffer.from(attestation.signature, 'base64')))
        return err(gatewayError('REVIEW_SIGNATURE_INVALID', 'Review signature invalid', 'review.signature.invalid'));
      const consumed = await this.nonces.consume({ issuer: attestation.issuer, keyId: attestation.keyId, nonce: attestation.nonce, reviewInputHash, expiresAt: attestation.expiresAt });
      if (!consumed.ok) return consumed;
      const receipt = Object.freeze({ attestation: Object.freeze({ ...attestation }), bindingHash: hashCanonical(expected), verifiedAt: now });
      this.#receipts.add(receipt); return ok(receipt);
    } catch { return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review attestation invalid', 'review.attestation.invalid')); }
  }
}
