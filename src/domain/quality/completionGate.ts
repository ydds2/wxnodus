// src/domain/quality/completionGate.ts — 完成门：只接受 verifier 实例签发的 receipt，任何漂移 fail closed
import type { ArtifactBinding, VerifiedEvidenceReceipt } from './evidence.js';
import type { ReviewBinding, ReviewerAttestationVerifier, VerifiedReviewerAttestationReceipt } from './review.js';
import type { FileEvidenceStore } from '../../infrastructure/quality/fileEvidenceStore.js';
import type { RunFinalStatus } from '../../protocol/runs.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface CompletionDecision { runId: string; status: RunFinalStatus; artifact: ArtifactBinding; criterionResults: Array<{ id: string; status: string }>; evidenceIds: string[]; reviewInputHash: string; reasons: string[]; decidedAt: string }
interface Input extends Omit<ReviewBinding, 'evidence'> { requiredCriterionIds: string[]; evidence: VerifiedEvidenceReceipt[]; review: VerifiedReviewerAttestationReceipt }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export class CompletionGate {
  constructor(private readonly evidenceStore: FileEvidenceStore, private readonly reviewerVerifier: ReviewerAttestationVerifier) {}
  decide(input: Input, decidedAt: string): OperationResult<CompletionDecision> {
    if (!input.evidence.length || !input.evidence.every(receipt => this.evidenceStore.owns(receipt)) || !this.reviewerVerifier.owns(input.review))
      return err(gatewayError('GATE_UNTRUSTED_INPUT', 'Gate accepts verifier-owned receipts only', 'gate.untrustedInput'));
    const records = input.evidence.map(item => item.record), refs = input.evidence.map(item => item.ref);
    if (records.some(record => record.runId !== input.runId || !same(record.artifact, input.artifact) || record.environment.snapshotId !== input.environment.snapshotId || record.environment.sha256 !== input.environment.sha256 || record.policy.snapshotId !== input.policy.snapshotId || record.policy.sha256 !== input.policy.sha256))
      return err(gatewayError('EVIDENCE_BINDING_MISMATCH', 'Evidence binding mismatch', 'evidence.binding.mismatch'));
    const review = input.review.attestation;
    if (review.runId !== input.runId || !same(review.artifact, input.artifact) || !same(review.environment, input.environment) || !same(review.policy, input.policy) || !same(review.evidence, refs))
      return err(gatewayError('REVIEW_BINDING_MISMATCH', 'Review binding mismatch', 'review.binding.mismatch'));
    const criteria = records.flatMap(record => record.criteria).filter(criterion => input.requiredCriterionIds.includes(criterion.id));
    const missing = input.requiredCriterionIds.some(id => !criteria.some(criterion => criterion.id === id));
    const status: RunFinalStatus = missing ? 'incomplete' : criteria.some(criterion => criterion.status === 'failed') || review.outcome === 'failed' ? 'failed'
      : criteria.some(criterion => criterion.status === 'cancelled') ? 'cancelled'
      : criteria.some(criterion => criterion.status === 'inconclusive') || review.outcome === 'inconclusive' ? 'inconclusive' : 'succeeded';
    return ok({ runId: input.runId, status, artifact: input.artifact, criterionResults: criteria.map(criterion => ({ id: criterion.id, status: criterion.status })),
      evidenceIds: refs.map(ref => ref.id), reviewInputHash: review.reviewInputHash, reasons: status === 'succeeded' ? [] : [status], decidedAt });
  }
}
