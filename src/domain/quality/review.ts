// src/domain/quality/review.ts — 独立复核：attestation 是不可信输入，receipt 只能由 verifier 签发
import { createHash, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { ArtifactBinding, DeepReadonly, EvidenceRef } from './evidence.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface ReviewRun { id: string; runId: string; maker: { actorId: string; contextHash: string }; reviewer: { actorId: string; contextHash: string }; artifact: ArtifactBinding; environment: { snapshotId: string; sha256: string }; policy: { snapshotId: string; sha256: string }; evidence: EvidenceRef[]; requiredCriterionIds: string[]; status: 'running' | 'completed'; startedAt: string; completedAt?: string; nonce: string }
export interface ReviewBinding { runId: string; artifact: ArtifactBinding; environment: ReviewRun['environment']; policy: ReviewRun['policy']; evidence: EvidenceRef[]; requiredCriterionIds: string[] }
/** schemaVersion 2 起 requiredCriterionIds 成为权威 signed requirement binding；v1 仅保留历史签名可验证性，不授权 succeeded */
export type ReviewerAttestationSchema = 1 | 2;
export interface ReviewerAttestation { schemaVersion: ReviewerAttestationSchema; reviewRunId: string; runId: string; outcome: 'passed' | 'failed' | 'inconclusive'; maker: ReviewRun['maker']; reviewer: ReviewRun['reviewer']; artifact: ArtifactBinding; environment: ReviewRun['environment']; policy: ReviewRun['policy']; evidence: EvidenceRef[]; requiredCriterionIds: string[]; issuer: string; keyId: string; nonce: string; issuedAt: string; expiresAt: string; reviewInputHash: string; signature: string }
export interface VerifiedReviewerAttestationReceipt { readonly attestation: DeepReadonly<ReviewerAttestation>; readonly bindingHash: string; readonly verifiedAt: string }
export interface ReviewNonceStore { consume(input: { issuer: string; keyId: string; nonce: string; reviewInputHash: string; expiresAt: string }): Promise<OperationResult<void>> }
export interface ReviewerKeyPolicy { issuer: string; keyId: string; algorithm: 'Ed25519'; publicKey: KeyObject; reviewerActorIds: readonly string[]; activeFrom: string; activeUntil: string; revokedAt?: string; maxAgeMs: number; maxClockSkewMs: number }
export interface ReviewerTrustPolicy { resolve(issuer: string, keyId: string): ReviewerKeyPolicy | undefined }

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const REVIEW_OUTCOMES = new Set<ReviewerAttestation['outcome']>(['passed', 'failed', 'inconclusive']);
const ATTESTATION_KEYS = [
  'schemaVersion', 'reviewRunId', 'runId', 'outcome', 'maker', 'reviewer', 'artifact', 'environment', 'policy', 'evidence', 'requiredCriterionIds',
  'issuer', 'keyId', 'nonce', 'issuedAt', 'expiresAt', 'reviewInputHash', 'signature',
] as const;

type PlainObject = Record<string, unknown>;

function hasToJSON(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    if (Object.prototype.hasOwnProperty.call(current, 'toJSON')) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function plainObject(value: unknown, required: readonly string[], optional: readonly string[] = []): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || hasToJSON(value))
    throw new Error('INVALID_PLAIN_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some(key => typeof key !== 'string') || required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => !allowed.has(key as string)))
    throw new Error('INVALID_PLAIN_OBJECT');
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('INVALID_PLAIN_OBJECT');
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as PlainObject;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || hasToJSON(value)) throw new Error('INVALID_ARRAY');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('INVALID_ARRAY');
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !expectedKeys.has(key))) throw new Error('INVALID_ARRAY');
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

function snapshotBinding(value: unknown): ReviewRun['environment'] {
  const object = plainObject(value, ['snapshotId', 'sha256']);
  return { snapshotId: safeId(object.snapshotId), sha256: sha256(object.sha256) };
}

function actor(value: unknown): ReviewRun['maker'] {
  const object = plainObject(value, ['actorId', 'contextHash']);
  return { actorId: safeId(object.actorId), contextHash: sha256(object.contextHash) };
}

function evidenceRef(value: unknown): EvidenceRef {
  const object = plainObject(value, ['id', 'sha256']);
  return { id: safeId(object.id), sha256: sha256(object.sha256) };
}

function evidenceRefs(value: unknown): EvidenceRef[] {
  const refs = denseArray(value).map(evidenceRef);
  if (refs.length === 0 || new Set(refs.map(ref => ref.id)).size !== refs.length) throw new Error('INVALID_EVIDENCE_REFS');
  return refs;
}

function requiredCriterionIds(value: unknown): string[] {
  const ids = denseArray(value).map(safeId);
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('INVALID_REQUIRED_CRITERIA');
  return ids;
}

export function normalizeReviewBinding(value: unknown): ReviewBinding {
  const object = plainObject(value, ['runId', 'artifact', 'environment', 'policy', 'evidence', 'requiredCriterionIds']);
  return {
    runId: safeId(object.runId),
    artifact: artifactBinding(object.artifact),
    environment: snapshotBinding(object.environment),
    policy: snapshotBinding(object.policy),
    evidence: evidenceRefs(object.evidence),
    requiredCriterionIds: requiredCriterionIds(object.requiredCriterionIds),
  };
}

export function normalizeReviewerAttestation(value: unknown): ReviewerAttestation {
  const object = plainObject(value, ATTESTATION_KEYS);
  if ((object.schemaVersion !== 1 && object.schemaVersion !== 2) ||
      typeof object.outcome !== 'string' || !REVIEW_OUTCOMES.has(object.outcome as ReviewerAttestation['outcome']))
    throw new Error('INVALID_ATTESTATION');
  if (typeof object.signature !== 'string' || !SIGNATURE.test(object.signature) || Buffer.from(object.signature, 'base64').byteLength !== 64)
    throw new Error('INVALID_SIGNATURE');
  return {
    schemaVersion: object.schemaVersion as ReviewerAttestationSchema,
    reviewRunId: safeId(object.reviewRunId),
    runId: safeId(object.runId),
    outcome: object.outcome as ReviewerAttestation['outcome'],
    maker: actor(object.maker),
    reviewer: actor(object.reviewer),
    artifact: artifactBinding(object.artifact),
    environment: snapshotBinding(object.environment),
    policy: snapshotBinding(object.policy),
    evidence: evidenceRefs(object.evidence),
    requiredCriterionIds: requiredCriterionIds(object.requiredCriterionIds),
    issuer: safeId(object.issuer),
    keyId: safeId(object.keyId),
    nonce: safeId(object.nonce),
    issuedAt: isoTime(object.issuedAt),
    expiresAt: isoTime(object.expiresAt),
    reviewInputHash: sha256(object.reviewInputHash),
    signature: object.signature,
  };
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_VALUE_UNSUPPORTED');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new Error('CANONICAL_VALUE_UNSUPPORTED');
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

const hashCanonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

function sameArtifact(left: ArtifactBinding, right: ArtifactBinding): boolean {
  return left.id === right.id && left.sha256 === right.sha256 && left.commitSha === right.commitSha;
}

function sameSnapshot(left: ReviewRun['environment'], right: ReviewRun['environment']): boolean {
  return left.snapshotId === right.snapshotId && left.sha256 === right.sha256;
}

function sameRefs(left: readonly EvidenceRef[], right: readonly EvidenceRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => ref.id === right[index]?.id && ref.sha256 === right[index]?.sha256);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function unsigned(run: ReviewRun, outcome: ReviewerAttestation['outcome'], authority: { issuer: string; keyId: string }, time: { issuedAt: string; expiresAt: string }) {
  return { schemaVersion: 2 as const, reviewRunId: run.id, runId: run.runId, outcome, maker: run.maker, reviewer: run.reviewer,
    artifact: run.artifact, environment: run.environment, policy: run.policy, evidence: run.evidence, requiredCriterionIds: run.requiredCriterionIds,
    issuer: authority.issuer, keyId: authority.keyId, nonce: run.nonce, issuedAt: time.issuedAt, expiresAt: time.expiresAt };
}

export async function createReviewerAttestation(run: ReviewRun, outcome: ReviewerAttestation['outcome'], authority: { issuer: string; keyId: string; sign(hash: Uint8Array): Promise<Uint8Array> }, time: { issuedAt: string; expiresAt: string }): Promise<OperationResult<ReviewerAttestation>> {
  try {
    const body = unsigned(run, outcome, authority, time);
    const reviewInputHash = hashCanonical(body);
    return ok({ ...body, reviewInputHash, signature: Buffer.from(await authority.sign(Buffer.from(reviewInputHash, 'hex'))).toString('base64') });
  } catch {
    return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review signing failed', 'review.attestation.invalid'));
  }
}

export class ReviewerAttestationVerifier {
  readonly #receipts = new WeakSet<object>();
  readonly #brand = true;
  constructor(private readonly policy: ReviewerTrustPolicy, private readonly nonces: ReviewNonceStore,
    private readonly clock: () => string = () => new Date().toISOString()) {}
  static isGenuine(value: unknown): value is ReviewerAttestationVerifier {
    return typeof value === 'object' && value !== null && #brand in value;
  }
  owns(receipt: unknown): receipt is VerifiedReviewerAttestationReceipt { return typeof receipt === 'object' && receipt !== null && this.#receipts.has(receipt); }

  async verify(attestation: ReviewerAttestation, expected: ReviewBinding): Promise<OperationResult<VerifiedReviewerAttestationReceipt>> {
    let normalized: ReviewerAttestation;
    let binding: ReviewBinding;
    let verifiedAt: string;
    try {
      normalized = normalizeReviewerAttestation(attestation);
      binding = normalizeReviewBinding(expected);
      verifiedAt = isoTime(this.clock());
    } catch {
      return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review attestation invalid', 'review.attestation.invalid'));
    }

    try {
      if (normalized.maker.actorId === normalized.reviewer.actorId || normalized.maker.contextHash === normalized.reviewer.contextHash)
        return err(gatewayError('REVIEWER_NOT_INDEPENDENT', 'Reviewer identity and context must both be independent', 'reviewer.notIndependent'));
      if (normalized.runId !== binding.runId || !sameArtifact(normalized.artifact, binding.artifact) || !sameSnapshot(normalized.environment, binding.environment) ||
          !sameSnapshot(normalized.policy, binding.policy) || !sameRefs(normalized.evidence, binding.evidence) ||
          !sameIds(normalized.requiredCriterionIds, binding.requiredCriterionIds))
        return err(gatewayError('REVIEW_BINDING_MISMATCH', 'Review binding mismatch', 'review.binding.mismatch'));

      const key = this.policy.resolve(normalized.issuer, normalized.keyId);
      if (!key) return err(gatewayError('REVIEW_ISSUER_NOT_ALLOWED', 'Review issuer/key unknown', 'review.issuer.notAllowed'));
      if (key.algorithm !== 'Ed25519' || key.revokedAt || !key.reviewerActorIds.includes(normalized.reviewer.actorId))
        return err(gatewayError('REVIEW_KEY_NOT_ALLOWED', 'Review key not allowed', 'review.key.notAllowed'));
      const nowMs = Date.parse(verifiedAt), issued = Date.parse(normalized.issuedAt), expires = Date.parse(normalized.expiresAt),
        activeFrom = Date.parse(key.activeFrom), activeUntil = Date.parse(key.activeUntil);
      if (![nowMs, issued, expires, activeFrom, activeUntil].every(Number.isFinite) || expires <= issued || issued > nowMs + key.maxClockSkewMs ||
          expires <= nowMs || nowMs - issued > key.maxAgeMs)
        return err(gatewayError('REVIEW_ATTESTATION_STALE', 'Review attestation stale', 'review.attestation.stale'));
      if (issued < activeFrom || issued >= activeUntil) return err(gatewayError('REVIEW_KEY_NOT_ALLOWED', 'Review key inactive', 'review.key.notAllowed'));

      const body = {
        schemaVersion: normalized.schemaVersion,
        reviewRunId: normalized.reviewRunId,
        runId: normalized.runId,
        outcome: normalized.outcome,
        maker: normalized.maker,
        reviewer: normalized.reviewer,
        artifact: normalized.artifact,
        environment: normalized.environment,
        policy: normalized.policy,
        evidence: normalized.evidence,
        requiredCriterionIds: normalized.requiredCriterionIds,
        issuer: normalized.issuer,
        keyId: normalized.keyId,
        nonce: normalized.nonce,
        issuedAt: normalized.issuedAt,
        expiresAt: normalized.expiresAt,
      };
      const reviewInputHash = hashCanonical(body);
      if (reviewInputHash !== normalized.reviewInputHash)
        return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Canonical review input mismatch', 'review.attestation.invalid'));
      if (!verifySignature(null, Buffer.from(reviewInputHash, 'hex'), key.publicKey, Buffer.from(normalized.signature, 'base64')))
        return err(gatewayError('REVIEW_SIGNATURE_INVALID', 'Review signature invalid', 'review.signature.invalid'));

      let candidate: VerifiedReviewerAttestationReceipt;
      try {
        candidate = Object.freeze({
          attestation: deepFreeze({ ...body, reviewInputHash, signature: normalized.signature }),
          bindingHash: hashCanonical(binding),
          verifiedAt,
        });
      } catch {
        return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review attestation invalid', 'review.attestation.invalid'));
      }
      const consumed = await this.nonces.consume({ issuer: normalized.issuer, keyId: normalized.keyId, nonce: normalized.nonce, reviewInputHash, expiresAt: normalized.expiresAt });
      if (!consumed.ok) return consumed;
      this.#receipts.add(candidate);
      return ok(candidate);
    } catch {
      return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review attestation invalid', 'review.attestation.invalid'));
    }
  }
}
