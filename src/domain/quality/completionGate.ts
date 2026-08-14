// src/domain/quality/completionGate.ts — 完成门：只接受 verifier 实例签发的 receipt，任何漂移 fail closed
// W3-01：只消费 closureStatus 'closed' 的 evidence——未闭包记录只能令判定 blocked/incomplete，绝不进入 required-criterion pass 集合。
// W1-09 布局（无 closure 字段、无 attachments）由 W1 store 写入时校验闭合，视为隐含 closed，收据信任仍只来自 WeakSet owns()。
import type { ArtifactBinding, EvidenceRef, VerifiedEvidenceReceipt, VerificationStatus } from './evidence.js';
import { normalizeReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type VerifiedReviewerAttestationReceipt } from './review.js';
import { FileEvidenceStore } from '../../infrastructure/quality/fileEvidenceStore.js';
import type { RunFinalStatus } from '../../protocol/runs.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface CompletionDecision { runId: string; status: RunFinalStatus; artifact: ArtifactBinding; criterionResults: Array<{ id: string; status: string }>; evidenceIds: string[]; reviewInputHash: string; reasons: string[]; decidedAt: string }
export interface CompletionGateInput extends Omit<ReviewBinding, 'evidence' | 'requiredCriterionIds'> { requiredCriterionIds: string[]; evidence: VerifiedEvidenceReceipt[]; review: VerifiedReviewerAttestationReceipt }

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERIFICATION_STATUSES = new Set<VerificationStatus>(['passed', 'failed', 'inconclusive', 'cancelled']);
const REVIEW_OUTCOMES = new Set(['passed', 'failed', 'inconclusive']);

type PlainObject = Record<string, unknown>;

function hasToJSON(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    if (Object.prototype.hasOwnProperty.call(current, 'toJSON')) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function plainObject(value: unknown, required?: readonly string[], optional: readonly string[] = []): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || hasToJSON(value))
    throw new Error('INVALID_PLAIN_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw new Error('INVALID_PLAIN_OBJECT');
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('INVALID_PLAIN_OBJECT');
  }
  if (required) {
    const allowed = new Set([...required, ...optional]);
    if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => !allowed.has(key as string)))
      throw new Error('INVALID_PLAIN_OBJECT');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as PlainObject;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || hasToJSON(value)) throw new Error('INVALID_ARRAY');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('INVALID_ARRAY');
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !expectedKeys.has(key))) throw new Error('INVALID_ARRAY');
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('INVALID_ARRAY');
    output.push(descriptor.value);
  }
  return output;
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error('INVALID_ID');
  return value;
}

function nonblank(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('INVALID_STRING');
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error('INVALID_SHA256');
  return value;
}

function isoTime(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_TIME');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error('INVALID_TIME');
  return value;
}

function artifactBinding(value: unknown): ArtifactBinding {
  const object = plainObject(value, ['id', 'sha256'], ['commitSha']);
  const artifact: ArtifactBinding = { id: safeId(object.id), sha256: sha256(object.sha256) };
  if (Object.hasOwn(object, 'commitSha')) {
    if (typeof object.commitSha !== 'string' || !COMMIT_SHA.test(object.commitSha)) throw new Error('INVALID_COMMIT_SHA');
    artifact.commitSha = object.commitSha;
  }
  return artifact;
}

interface SnapshotBinding { snapshotId: string; sha256: string }
function snapshotBinding(value: unknown): SnapshotBinding {
  const object = plainObject(value, ['snapshotId', 'sha256']);
  return { snapshotId: safeId(object.snapshotId), sha256: sha256(object.sha256) };
}

function evidenceEnvironmentBinding(value: unknown): SnapshotBinding {
  const object = plainObject(value, ['snapshotId', 'sha256', 'platform', 'arch']);
  safeId(object.snapshotId);
  sha256(object.sha256);
  nonblank(object.platform);
  nonblank(object.arch);
  return { snapshotId: object.snapshotId as string, sha256: object.sha256 as string };
}

function evidencePolicyBinding(value: unknown): SnapshotBinding {
  const object = plainObject(value, ['snapshotId', 'sha256', 'decisionId']);
  safeId(object.snapshotId);
  sha256(object.sha256);
  safeId(object.decisionId);
  return { snapshotId: object.snapshotId as string, sha256: object.sha256 as string };
}

function evidenceRef(value: unknown): EvidenceRef {
  const object = plainObject(value, ['id', 'sha256']);
  return { id: safeId(object.id), sha256: sha256(object.sha256) };
}

function canonicalPlainData(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INVALID_PLAIN_DATA');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('INVALID_PLAIN_DATA');
  if (ancestors.has(value)) throw new Error('INVALID_PLAIN_DATA');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${denseArray(value).map(item => canonicalPlainData(item, ancestors)).join(',')}]`;
    const object = plainObject(value);
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalPlainData(object[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

interface NormalizedCriterion {
  id: string;
  description: string;
  required: boolean;
  expected: string;
  status: VerificationStatus;
}

function criterion(value: unknown): NormalizedCriterion {
  const object = plainObject(value, ['id', 'description', 'required', 'expected', 'observed', 'status'], ['failureCode']);
  const id = safeId(object.id);
  const description = nonblank(object.description);
  if (typeof object.required !== 'boolean' || typeof object.status !== 'string' || !VERIFICATION_STATUSES.has(object.status as VerificationStatus))
    throw new Error('INVALID_CRITERION');
  const expected = canonicalPlainData(object.expected);
  canonicalPlainData(object.observed);
  if (Object.hasOwn(object, 'failureCode')) nonblank(object.failureCode);
  return { id, description, required: object.required, expected, status: object.status as VerificationStatus };
}

function criteria(value: unknown): NormalizedCriterion[] {
  return denseArray(value).map(criterion);
}

function requiredCriterionIds(value: unknown): string[] {
  const ids = denseArray(value).map(safeId);
  if (ids.length === 0) throw new Error('INVALID_REQUIRED_CRITERIA');
  return ids;
}

function sameArtifact(left: ArtifactBinding, right: ArtifactBinding): boolean {
  return left.id === right.id && left.sha256 === right.sha256 && left.commitSha === right.commitSha;
}

function sameSnapshot(left: SnapshotBinding, right: SnapshotBinding): boolean {
  return left.snapshotId === right.snapshotId && left.sha256 === right.sha256;
}

function sameRefs(left: readonly EvidenceRef[], right: readonly EvidenceRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => ref.id === right[index]?.id && ref.sha256 === right[index]?.sha256);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameCriterionDefinition(left: NormalizedCriterion, right: NormalizedCriterion): boolean {
  return left.description === right.description && left.required === right.required && left.expected === right.expected;
}

function attachmentRefs(value: unknown): void {
  for (const item of denseArray(value)) {
    const object = plainObject(item, ['attachmentId', 'relativePath', 'sha256', 'bytes'], ['path']);
    safeId(object.attachmentId);
    nonblank(object.relativePath);
    sha256(object.sha256);
    if (!Number.isSafeInteger(object.bytes) || (object.bytes as number) < 0) throw new Error('INVALID_ATTACHMENT');
    if (Object.hasOwn(object, 'path')) nonblank(object.path);
  }
}

function closure(value: unknown): void {
  const object = plainObject(value, ['status', 'attachmentIds']);
  if (object.status !== 'closed') throw new Error('INVALID_CLOSURE');
  const ids = denseArray(object.attachmentIds).map(safeId);
  if (new Set(ids).size !== ids.length) throw new Error('INVALID_CLOSURE');
}

interface NormalizedRecord {
  id: string;
  runId: string;
  artifact: ArtifactBinding;
  environment: SnapshotBinding;
  policy: SnapshotBinding;
  criteria: NormalizedCriterion[];
  verifierStatus: VerificationStatus;
  authorityStatus: VerificationStatus;
  unclosed: boolean;
}

function evidenceRecord(value: unknown): NormalizedRecord {
  const object = plainObject(value);
  const id = safeId(object.id);
  const runId = safeId(object.runId);
  const artifact = artifactBinding(object.artifact);
  const environment = evidenceEnvironmentBinding(object.environment);
  const policy = evidencePolicyBinding(object.policy);
  const normalizedCriteria = criteria(object.criteria);
  const verifier = plainObject(object.verifier, ['id', 'version', 'inputSha256', 'status']);
  safeId(verifier.id);
  nonblank(verifier.version);
  sha256(verifier.inputSha256);
  if (typeof verifier.status !== 'string' || !VERIFICATION_STATUSES.has(verifier.status as VerificationStatus)) throw new Error('INVALID_STATUS');
  const authority = plainObject(object.authority, ['source', 'sourceRecordId', 'sourceStatus']);
  nonblank(authority.source);
  safeId(authority.sourceRecordId);
  if (typeof authority.sourceStatus !== 'string' || !VERIFICATION_STATUSES.has(authority.sourceStatus as VerificationStatus)) throw new Error('INVALID_STATUS');
  const hasAttachments = Object.hasOwn(object, 'attachments');
  const hasClosure = Object.hasOwn(object, 'closure');
  if (hasAttachments) attachmentRefs(object.attachments);
  if (hasClosure) closure(object.closure);
  return {
    id,
    runId,
    artifact,
    environment,
    policy,
    criteria: normalizedCriteria,
    verifierStatus: verifier.status as VerificationStatus,
    authorityStatus: authority.sourceStatus as VerificationStatus,
    unclosed: hasClosure ? (plainObject(object.closure, ['status', 'attachmentIds']).status !== 'closed') : hasAttachments,
  };
}

export class CompletionGate {
  readonly #brand = true;
  readonly #evidenceStore: FileEvidenceStore;
  readonly #reviewerVerifier: ReviewerAttestationVerifier;

  constructor(evidenceStore: FileEvidenceStore, reviewerVerifier: ReviewerAttestationVerifier) {
    if (!FileEvidenceStore.isGenuine(evidenceStore) || !ReviewerAttestationVerifier.isGenuine(reviewerVerifier)) throw new TypeError('COMPLETION_GATE_AUTHORITY_INVALID');
    this.#evidenceStore = evidenceStore;
    this.#reviewerVerifier = reviewerVerifier;
  }

  static isGenuine(value: unknown): value is CompletionGate {
    return typeof value === 'object' && value !== null && #brand in value;
  }

  decide(input: CompletionGateInput, decidedAt: string): OperationResult<CompletionDecision> {
    let evidenceIds: string[] | undefined;
    try {
      const runtimeInput = plainObject(input, ['runId', 'artifact', 'environment', 'policy', 'requiredCriterionIds', 'evidence', 'review']);
      const evidenceReceipts = denseArray(runtimeInput.evidence);
      const reviewReceipt = runtimeInput.review;
      if (evidenceReceipts.length === 0 ||
          !evidenceReceipts.every(receipt => FileEvidenceStore.prototype.owns.call(this.#evidenceStore, receipt)) ||
          !ReviewerAttestationVerifier.prototype.owns.call(this.#reviewerVerifier, reviewReceipt))
        return err(gatewayError('GATE_UNTRUSTED_INPUT', 'Gate accepts verifier-owned receipts only', 'gate.untrustedInput'));

      const receiptObjects = evidenceReceipts.map(receipt => plainObject(receipt, ['record', 'ref', 'verifiedAt']));
      const refs = receiptObjects.map(receipt => evidenceRef(receipt.ref));
      evidenceIds = refs.map(ref => ref.id);
      if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('INVALID_EVIDENCE_REFS');
      for (const receipt of receiptObjects) isoTime(receipt.verifiedAt);
      const reviewReceiptObject = plainObject(reviewReceipt, ['attestation', 'bindingHash', 'verifiedAt']);
      sha256(reviewReceiptObject.bindingHash);
      isoTime(reviewReceiptObject.verifiedAt);

      const runId = safeId(runtimeInput.runId);
      const artifact = artifactBinding(runtimeInput.artifact);
      const environment = snapshotBinding(runtimeInput.environment);
      const policy = snapshotBinding(runtimeInput.policy);
      const requiredIds = requiredCriterionIds(runtimeInput.requiredCriterionIds);
      if (new Set(requiredIds).size !== requiredIds.length)
        return err(gatewayError('COMPLETION_REQUIRED_CRITERION_DUPLICATE', 'Required criterion IDs must be unique', 'completion.requiredCriterion.duplicate'), evidenceIds);
      isoTime(decidedAt);

      const records = receiptObjects.map(receipt => evidenceRecord(receipt.record));
      if (records.some((record, index) => record.id !== refs[index]?.id || record.runId !== runId || !sameArtifact(record.artifact, artifact) ||
          !sameSnapshot(record.environment, environment) || !sameSnapshot(record.policy, policy)))
        return err(gatewayError('EVIDENCE_BINDING_MISMATCH', 'Evidence binding mismatch', 'evidence.binding.mismatch'), evidenceIds);
      const submittedRequiredIds = records.flatMap(record => record.criteria).filter(item => item.required).map(item => item.id)
        .filter((id, index, all) => all.indexOf(id) === index);
      if (submittedRequiredIds.some(id => !requiredIds.includes(id)))
        return err(gatewayError('COMPLETION_REQUIRED_CRITERION_BINDING_MISMATCH', 'Submitted required criteria do not match the signed acceptance binding', 'completion.requiredCriterion.bindingMismatch'), evidenceIds);

      const review = normalizeReviewerAttestation(reviewReceiptObject.attestation);
      if (!REVIEW_OUTCOMES.has(review.outcome)) throw new Error('INVALID_REVIEW_OUTCOME');
      // 只有 v2（权威 required criterion binding）可授权 succeeded；历史 v1 签名可验证但不得放行
      if (review.schemaVersion !== 2)
        return err(gatewayError('REVIEW_ATTESTATION_SCHEMA_UNSUPPORTED', 'Completion requires a v2 reviewer attestation with authoritative requirement binding', 'review.attestation.schemaUnsupported'), evidenceIds);
      const decidedAtMs = Date.parse(decidedAt), reviewerVerifiedAtMs = Date.parse(reviewReceiptObject.verifiedAt as string), expiresAtMs = Date.parse(review.expiresAt);
      if (![decidedAtMs, reviewerVerifiedAtMs, expiresAtMs].every(Number.isFinite) || decidedAtMs < reviewerVerifiedAtMs || decidedAtMs >= expiresAtMs)
        return err(gatewayError('COMPLETION_REVIEW_TIME_INVALID', 'Completion decision time is outside the owned review validity window', 'completion.review.timeInvalid'), evidenceIds);
      if (review.runId !== runId || !sameArtifact(review.artifact, artifact) || !sameSnapshot(review.environment, environment) ||
          !sameSnapshot(review.policy, policy) || !sameRefs(review.evidence, refs) || !sameIds(review.requiredCriterionIds, requiredIds))
        return err(gatewayError('REVIEW_BINDING_MISMATCH', 'Review binding mismatch', 'review.binding.mismatch'), evidenceIds);

      if (records.some(record => record.unclosed)) {
        const decision = { runId, status: 'blocked' as const, artifact, criterionResults: [], evidenceIds,
          reviewInputHash: review.reviewInputHash, reasons: ['COMPLETION_EVIDENCE_NOT_CLOSED'], decidedAt };
        return ok(decision, evidenceIds);
      }

      const selectedCriteria = records.flatMap(record => record.criteria).filter(item => requiredIds.includes(item.id));
      const criterionResults = new Map<string, NormalizedCriterion>();
      for (const item of selectedCriteria) {
        if (!item.required)
          return err(gatewayError('COMPLETION_CRITERION_DEFINITION_CONFLICT', 'Required criterion definition conflicts', 'completion.criterionDefinition.conflict'), evidenceIds);
        const prior = criterionResults.get(item.id);
        if (prior && !sameCriterionDefinition(prior, item))
          return err(gatewayError('COMPLETION_CRITERION_DEFINITION_CONFLICT', 'Required criterion definitions conflict', 'completion.criterionDefinition.conflict'), evidenceIds);
        if (prior && prior.status !== item.status)
          return err(gatewayError('COMPLETION_CRITERION_RESULT_CONFLICT', 'Criterion results conflict', 'completion.criterionResult.conflict'), evidenceIds);
        criterionResults.set(item.id, item);
      }

      if (records.some(record => record.criteria.some(item => item.status !== record.verifierStatus || item.status !== record.authorityStatus)))
        return err(gatewayError('COMPLETION_EVIDENCE_STATUS_CONFLICT', 'Evidence criterion and authority statuses conflict', 'completion.evidence.statusConflict'), evidenceIds);
      const missing = requiredIds.some(id => !criterionResults.has(id));
      const orderedCriteria = requiredIds.map(id => criterionResults.get(id)).filter((item): item is NormalizedCriterion => item !== undefined);
      const requiredFailed = orderedCriteria.some(item => item.status === 'failed');
      const status: RunFinalStatus = missing ? 'incomplete' : requiredFailed || review.outcome === 'failed' ? 'failed'
        : orderedCriteria.some(item => item.status === 'cancelled') ? 'cancelled'
        : orderedCriteria.some(item => item.status === 'inconclusive') || review.outcome === 'inconclusive' ? 'inconclusive' : 'succeeded';
      const reasons = missing ? ['COMPLETION_REQUIRED_CRITERION_MISSING']
        : requiredFailed ? ['COMPLETION_REQUIRED_CRITERION_FAILED']
        : status === 'succeeded' ? [] : [status];
      const decision = { runId, status, artifact, criterionResults: orderedCriteria.map(item => ({ id: item.id, status: item.status })),
        evidenceIds, reviewInputHash: review.reviewInputHash, reasons, decidedAt };
      return ok(decision, evidenceIds);
    } catch {
      return err(gatewayError('COMPLETION_GATE_INVALID_INPUT', 'Completion gate input invalid', 'completion.gate.invalidInput'), evidenceIds);
    }
  }
}
