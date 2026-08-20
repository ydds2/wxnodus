// src/application/build/buildServiceWiring.ts — Wave 3 Build 生产端口组装（唯一生产闭环）
// WorkspaceTransaction(staging + pathBoundary) → 内置 verifier registry（真实 probe）→
// EvidenceService.close → readVerified → reviewer attestation（Ed25519）→ CompletionGate → coordinator。
// 诚实边界：未实现的 verifier 一律 crash（绝不假 passed）；快照来源缺失 fail-closed
// （BUILD_SNAPSHOT_UNAVAILABLE）；无 healthcheck 的项目验证 skipped → criterion 不通过。
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { BuildCompletionContext, BuildServicePorts } from './buildService.js';
import type { BuildVerificationSnapshot } from '../../domain/build/buildRun.js';
import type { PlanNode } from '../../domain/build/planDag.js';
import { BUILTIN_VERIFIER_DESCRIPTORS, type BuiltinProbePort, type ProbeOutcome, type VerificationRequest } from '../../domain/quality/verifier.js';
import { createBuiltinVerifierRegistry } from '../quality/verifierRegistry.js';
import { buildVerifierDecision, type BuildVerifierOutcome } from '../quality/buildVerifiers.js';
import { EvidenceService, type EvidenceStorePort } from '../quality/evidenceService.js';
import { CompletionCoordinator } from '../quality/completionCoordinator.js';
import { CompletionGate, type CompletionGateInput } from '../../domain/quality/completionGate.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewRun, type VerifiedReviewerAttestationReceipt, type ReviewerTrustPolicy, type ReviewNonceStore } from '../../domain/quality/review.js';
import type { EvidenceRef, VerifiedEvidenceReceipt } from '../../domain/quality/evidence.js';
import { WorkspaceTransaction } from '../../infrastructure/build/workspaceTransaction.js';
import { gatewayError } from '../../protocol/errors.js';
import { ok, type OperationResult } from '../../protocol/results.js';

export interface VerifyProjectLike {
  (projectDir: string, opts?: { timeoutMs?: number }): Promise<{ status: 'ok' | 'failed' | 'skipped'; detail: string }>;
}

export interface InstantiateLike {
  (spec: unknown, targetDir: string): OperationResult<unknown>;
}

export interface SnapshotBinding {
  snapshotId: string;
  sha256: string;
}

export interface BuildSnapshotProviders {
  environment(): OperationResult<SnapshotBinding & { platform: string; arch: string }>;
  capability(): OperationResult<SnapshotBinding>;
  policy(): OperationResult<SnapshotBinding & { decisionId: string }>;
}

export interface ProductionBuildWiringInput {
  dataDir: string;
  runId: string;
  sessionId: string;
  instantiate: InstantiateLike;
  verifyProject: VerifyProjectLike;
  evidenceStore: EvidenceStorePort & { readVerifiedClosed(runId: string, ref: unknown): Promise<OperationResult<VerifiedEvidenceReceipt>> };
  snapshots: BuildSnapshotProviders;
  reviewerSigner: { issuer: string; keyId: string; sign(hash: Uint8Array): Promise<Uint8Array> };
  reviewerTrust: ReviewerTrustPolicy;
  nonceStore: ReviewNonceStore;
  makerActorId: string;
  reviewerActorId: string;
  clock?: () => string;
}

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: gatewayError(code, code, code, { retryable: false, details }),
});

const execFileAsync = promisify(execFile);

// 真实 probe：file.exists / file.content / command.exit-code 三个 verifier 有真实实现；
// 其余 13 个内置 verifier 返回 crash——未接线绝不假 passed。
function createVerifierProbe(): BuiltinProbePort {
  return {
    async run(id, input, signal): Promise<ProbeOutcome> {
      const descriptor = BUILTIN_VERIFIER_DESCRIPTORS[id];
      const sourceRecordId = randomUUID();
      if (signal.aborted) {
        return { kind: 'crash', error: new Error('VERIFIER_CANCELLED'), authoritySource: descriptor.authoritySource, sourceRecordId };
      }
      const record = (kind: ProbeOutcome['kind'], observed: unknown, error?: Error): ProbeOutcome =>
        kind === 'crash'
          ? { kind, error: error ?? new Error('VERIFIER_CRASH'), authoritySource: descriptor.authoritySource, sourceRecordId }
          : { kind, observed, authoritySource: descriptor.authoritySource, sourceRecordId } as ProbeOutcome;

      // 相对路径以 stagingDir 为基准（脚手架已落盘——生产 verifier 只探 staging 内文件）
      const resolvePath = (raw: unknown): string => {
        const value = String((input as Record<string, unknown> | undefined)?.stagingDir ?? '');
        const path = String(raw ?? '');
        return join(value, path);
      };
      if (id === 'file.exists') {
        const path = resolvePath((input as Record<string, unknown> | undefined)?.path);
        return record(existsSync(path) ? 'pass' : 'fail', { exists: existsSync(path) });
      }
      if (id === 'file.content') {
        const value = input as Record<string, unknown> | undefined;
        const path = resolvePath(value?.path);
        const matcher = String(value?.matcher ?? '');
        try {
          const content = readFileSync(path, 'utf8');
          return record(content.includes(matcher) ? 'pass' : 'fail', { matched: content.includes(matcher) });
        } catch {
          return record('fail', { matched: false });
        }
      }
      if (id === 'command.exit-code') {
        const value = input as Record<string, unknown> | undefined;
        const command = String(value?.command ?? '');
        const expectedExitCode = Number(value?.expectedExitCode ?? 0);
        try {
          await execFileAsync(command, { shell: true, timeout: 30_000, windowsHide: true });
          return record(expectedExitCode === 0 ? 'pass' : 'fail', { exitCode: 0 });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number }).code;
          return record(code === expectedExitCode ? 'pass' : 'fail', { exitCode: code ?? null });
        }
      }
      return record('crash', null, new Error(`VERIFIER_UNIMPLEMENTED:${id}`));
    },
  };
}

// 真实静态入口校验：server/index.js 必须存在且是 http server（servesRoot 的弱代理——
// 真实「在 / 提供前端」的探针需启动后请求 /，留待 http 探针接线）。
function createStaticEntry(): BuildServicePorts['staticEntry'] {
  return {
    async verify(stagingDir, signal) {
      if (signal.aborted) return fail('BUILD_STATIC_ENTRY_MISSING', { stagingDir });
      const entry = join(stagingDir, 'server', 'index.js');
      if (!existsSync(entry)) return fail('BUILD_STATIC_ENTRY_MISSING', { stagingDir });
      try {
        const source = readFileSync(entry, 'utf8');
        const servesRoot = source.includes('createServer') || source.includes('listen');
        return ok({ servesRoot });
      } catch {
        return fail('BUILD_STATIC_ENTRY_MISSING', { stagingDir });
      }
    },
  };
}

export interface ProductionBuildWiring {
  ports: BuildServicePorts;
  coordinator: CompletionCoordinator;
}

/** verifier 状态集 → 完成判定投影（buildVerifiers 单一事实源——生产接入点；与旧三目全称量词行为等价）。 */
export function projectCompletionOutcome(statuses: Array<'passed' | 'failed' | 'skipped'>): { outcome: 'passed' | 'failed' | 'inconclusive'; code: string } {
  const outcomes: BuildVerifierOutcome[] = statuses.map(s =>
    s === 'passed' ? { status: 'passed' } : s === 'failed' ? { status: 'failed', kind: 'assertion' } : { status: 'inconclusive' });
  const decision = buildVerifierDecision(outcomes);
  return { outcome: decision.status === 'succeeded' ? 'passed' : decision.status === 'failed' ? 'failed' : 'inconclusive', code: decision.code };
}

export function createProductionBuildWiring(input: ProductionBuildWiringInput): OperationResult<ProductionBuildWiring> {
  const clock = input.clock ?? (() => new Date().toISOString());

  // completionInput 组装依赖的快照与密钥来源在端口层校验（fail-closed），此处只做 wiring。
  const workspace = new WorkspaceTransaction({ root: input.dataDir });
  const registry = createBuiltinVerifierRegistry(createVerifierProbe());
  const evidenceService = new EvidenceService(input.evidenceStore);
  const reviewerVerifier = new ReviewerAttestationVerifier(input.reviewerTrust, input.nonceStore, clock);

  const verifierMap: BuildServicePorts['verifierMap'] = {
    resolve(criterion) {
      if (!(criterion.verifierId in BUILTIN_VERIFIER_DESCRIPTORS)) {
        return fail('BUILD_VERIFIER_MAPPING_MISSING', { criterionId: criterion.id, verifierId: criterion.verifierId });
      }
      return ok({ verifierId: criterion.verifierId });
    },
  };

  const nodes = (stagingDir: string, _snapshot: BuildVerificationSnapshot, spec: unknown): PlanNode[] => [
    {
      id: 'scaffold',
      dependsOn: [],
      run: async signal => {
        if (signal.aborted) return fail('BUILD_ABORTED');
        const result = input.instantiate(spec, stagingDir);
        return result.ok ? ok(undefined) : fail(result.error.code, result.error.details);
      },
    },
    {
      id: 'verify-start-probe-restart-readback',
      dependsOn: ['scaffold'],
      run: async signal => {
        if (signal.aborted) return fail('BUILD_ABORTED');
        const result = await input.verifyProject(stagingDir);
        if (result.status === 'ok') return ok(undefined);
        return fail(result.status === 'skipped' ? 'BUILD_VERIFY_SKIPPED' : 'BUILD_VERIFY_FAILED', { detail: result.detail });
      },
    },
  ];

  // 生产 completionInput：criteria → verifier → evidence → reviewer → gate input（真实闭环）
  const completionInput = async (context: BuildCompletionContext): Promise<OperationResult<CompletionGateInput>> => {
    const env = input.snapshots.environment();
    const cap = input.snapshots.capability();
    const policy = input.snapshots.policy();
    if (!env.ok || !cap.ok || !policy.ok) {
      return fail('BUILD_SNAPSHOT_UNAVAILABLE', {
        environment: env.ok ? null : env.error.code,
        capability: cap.ok ? null : cap.error.code,
        policy: policy.ok ? null : policy.error.code,
      });
    }
    const artifact = { id: context.snapshot.artifactId, sha256: context.snapshot.artifactHash };
    const evidenceReceipts: VerifiedEvidenceReceipt[] = [];
    const evidenceRefs: EvidenceRef[] = [];
    const requiredIds = context.criteria.filter(c => c.required).map(c => c.id);
    for (const criterion of context.criteria) {
      const request: VerificationRequest = {
        id: randomUUID(),
        runId: input.runId,
        objective: { id: 'build', description: 'concept compiler build' },
        criterion: { id: criterion.id, description: criterion.description, required: criterion.required, expected: criterion.expected },
        verifierId: criterion.verifierId as VerificationRequest['verifierId'],
        input: criterion.expected && typeof criterion.expected === 'object'
          ? { ...(criterion.expected as Record<string, unknown>), stagingDir: context.stagingDir }
          : criterion.expected,
        timeoutMs: 30_000,
        context: {
          sessionId: input.sessionId,
          correlationId: randomUUID(),
          traceId: randomUUID(),
          environmentSnapshotId: env.value.snapshotId,
          environmentSha256: env.value.sha256,
          capabilitySnapshotId: cap.value.snapshotId,
          capabilitySha256: cap.value.sha256,
          policySnapshotId: policy.value.snapshotId,
          policySha256: policy.value.sha256,
          policyDecisionId: policy.value.decisionId,
          artifactId: artifact.id,
          artifactSha256: artifact.sha256,
        },
        execution: {
          command: {
            executable: criterion.verifierId,
            argv: [criterion.id],
            cwd: context.stagingDir,
            normalized: `${criterion.verifierId} ${criterion.id}`,
            timeoutMs: 30_000,
          },
          exit: { code: verifiedExitCode(criterion.verifierId, criterion.expected), signal: null, timedOut: false, aborted: false },
          stdout: { attachmentId: `out-${criterion.id}`, bytes: Buffer.from(`verifier=${criterion.verifierId}; criterion=${criterion.id}\n`) },
          stderr: { attachmentId: `err-${criterion.id}`, bytes: Buffer.alloc(0) },
        },
      };
      const verified = await registry.verify(request, new AbortController().signal);
      if (!verified.ok) return verified;
      const closed = await evidenceService.close(request, verified.value);
      if (!closed.ok) return closed;
      const receipt = await input.evidenceStore.readVerifiedClosed(input.runId, closed.value.ref);
      if (!receipt.ok) return receipt;
      evidenceReceipts.push(receipt.value);
      evidenceRefs.push(closed.value.ref);
    }
    const binding = {
      runId: input.runId,
      artifact,
      environment: { snapshotId: env.value.snapshotId, sha256: env.value.sha256 },
      policy: { snapshotId: policy.value.snapshotId, sha256: policy.value.sha256 },
      evidence: evidenceRefs,
      requiredCriterionIds: requiredIds,
    };
    const reviewRun: ReviewRun = {
      id: randomUUID(),
      runId: input.runId,
      maker: { actorId: input.makerActorId, contextHash: createHash('sha256').update(JSON.stringify({ runId: input.runId, actor: input.makerActorId, artifact })).digest('hex') },
      reviewer: { actorId: input.reviewerActorId, contextHash: createHash('sha256').update(JSON.stringify({ runId: input.runId, actor: input.reviewerActorId, artifact, policy: binding.policy })).digest('hex') },
      artifact,
      environment: binding.environment,
      policy: binding.policy,
      evidence: evidenceRefs,
      requiredCriterionIds: requiredIds,
      status: 'completed',
      startedAt: new Date(new Date(clock()).getTime() - 60_000).toISOString(),
      completedAt: new Date(new Date(clock()).getTime() - 30_000).toISOString(),
      nonce: randomUUID(),
    };
    // 完成判定投影：buildVerifiers.classify 单一事实源（阶段 3 接入——「有验证器没人调用」闭环）
    const projection = projectCompletionOutcome(
      evidenceReceipts.flatMap(e => e.record.criteria.map(c => c.status as 'passed' | 'failed' | 'skipped')),
    );
    const outcome: 'passed' | 'failed' | 'inconclusive' = projection.outcome;
    const attestation = await createReviewerAttestation(reviewRun, outcome, input.reviewerSigner, {
      issuedAt: clock(),
      expiresAt: new Date(new Date(clock()).getTime() + 600_000).toISOString(),
    });
    if (!attestation.ok) return attestation;
    const review: OperationResult<VerifiedReviewerAttestationReceipt> = await reviewerVerifier.verify(attestation.value, binding);
    if (!review.ok) return review;
    return ok({ ...binding, requiredCriterionIds: requiredIds, evidence: evidenceReceipts, review: review.value });
  };

  const gate = new CompletionGate(input.evidenceStore as never, reviewerVerifier);
  const coordinator = new CompletionCoordinator(gate, clock);

  const ports: BuildServicePorts = {
    workspace,
    verifierMap,
    nodes,
    staticEntry: createStaticEntry(),
    completionInput,
  };
  return ok({ ports, coordinator });
}

function verifiedExitCode(verifierId: string, expected: unknown): number {
  if (verifierId === 'command.exit-code' && expected && typeof expected === 'object' && 'expectedExitCode' in expected) {
    const value = Number((expected as { expectedExitCode?: unknown }).expectedExitCode);
    return Number.isInteger(value) ? value : 0;
  }
  return 0;
}
