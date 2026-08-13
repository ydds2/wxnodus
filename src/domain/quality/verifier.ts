// src/domain/quality/verifier.ts — 内置 verifier 契约（16 个稳定 id/descriptor；W1-09 WeakSet 信任模型延续，authority 不引入 trusted 字段）
import type { GatewayError } from '../../protocol/errors.js';
import type { OperationResult } from '../../protocol/results.js';

export const BUILTIN_VERIFIER_IDS = [
  'command.exit-code', 'typescript.typecheck', 'npm.build', 'npm.test',
  'file.exists', 'file.content', 'workspace.diff', 'json.schema',
  'process.readiness', 'http.contract', 'database.query', 'browser.dom',
  'browser.url', 'uia.property', 'screenshot.ocr', 'human.approval',
] as const;

export type BuiltinVerifierId = typeof BUILTIN_VERIFIER_IDS[number];
export type VerificationStatus = 'passed' | 'failed' | 'inconclusive' | 'cancelled';
export type AuthoritySource = 'process-supervisor' | 'filesystem-reader' | 'workspace-reader' |
  'http-client' | 'database-client' | 'browser-driver' | 'uia-driver' | 'ocr-engine' |
  'approval-repository';

export interface VerifierDescriptor {
  id: BuiltinVerifierId;
  version: '1.0.0';
  requiredInputKeys: readonly string[];
  requiredCapabilities: readonly string[];
  authoritySource: AuthoritySource;
}

export const BUILTIN_VERIFIER_DESCRIPTORS: Record<BuiltinVerifierId, VerifierDescriptor> = {
  'command.exit-code': { id: 'command.exit-code', version: '1.0.0', requiredInputKeys: ['command', 'expectedExitCode'], requiredCapabilities: ['process.execute'], authoritySource: 'process-supervisor' },
  'typescript.typecheck': { id: 'typescript.typecheck', version: '1.0.0', requiredInputKeys: ['projectDir'], requiredCapabilities: ['process.execute', 'typescript'], authoritySource: 'process-supervisor' },
  'npm.build': { id: 'npm.build', version: '1.0.0', requiredInputKeys: ['projectDir'], requiredCapabilities: ['process.execute', 'npm'], authoritySource: 'process-supervisor' },
  'npm.test': { id: 'npm.test', version: '1.0.0', requiredInputKeys: ['projectDir'], requiredCapabilities: ['process.execute', 'npm'], authoritySource: 'process-supervisor' },
  'file.exists': { id: 'file.exists', version: '1.0.0', requiredInputKeys: ['path'], requiredCapabilities: ['filesystem.read'], authoritySource: 'filesystem-reader' },
  'file.content': { id: 'file.content', version: '1.0.0', requiredInputKeys: ['path', 'matcher'], requiredCapabilities: ['filesystem.read'], authoritySource: 'filesystem-reader' },
  'workspace.diff': { id: 'workspace.diff', version: '1.0.0', requiredInputKeys: ['workspace', 'expected'], requiredCapabilities: ['workspace.read'], authoritySource: 'workspace-reader' },
  'json.schema': { id: 'json.schema', version: '1.0.0', requiredInputKeys: ['value', 'schema'], requiredCapabilities: ['json.schema'], authoritySource: 'filesystem-reader' },
  'process.readiness': { id: 'process.readiness', version: '1.0.0', requiredInputKeys: ['processId', 'probe'], requiredCapabilities: ['process.inspect'], authoritySource: 'process-supervisor' },
  'http.contract': { id: 'http.contract', version: '1.0.0', requiredInputKeys: ['request', 'expected'], requiredCapabilities: ['network.http'], authoritySource: 'http-client' },
  'database.query': { id: 'database.query', version: '1.0.0', requiredInputKeys: ['connectionRef', 'query', 'expected'], requiredCapabilities: ['database.query'], authoritySource: 'database-client' },
  'browser.dom': { id: 'browser.dom', version: '1.0.0', requiredInputKeys: ['sessionId', 'selector', 'expected'], requiredCapabilities: ['browser.dom'], authoritySource: 'browser-driver' },
  'browser.url': { id: 'browser.url', version: '1.0.0', requiredInputKeys: ['sessionId', 'expectedUrl'], requiredCapabilities: ['browser.url'], authoritySource: 'browser-driver' },
  'uia.property': { id: 'uia.property', version: '1.0.0', requiredInputKeys: ['runtimeId', 'property', 'expected'], requiredCapabilities: ['windows.uia'], authoritySource: 'uia-driver' },
  'screenshot.ocr': { id: 'screenshot.ocr', version: '1.0.0', requiredInputKeys: ['imageRef', 'expectedText'], requiredCapabilities: ['screenshot.capture', 'ocr'], authoritySource: 'ocr-engine' },
  'human.approval': { id: 'human.approval', version: '1.0.0', requiredInputKeys: ['grantId', 'requestHash'], requiredCapabilities: ['approval.repository'], authoritySource: 'approval-repository' },
};

export interface VerificationRequest {
  id: string;
  runId: string;
  objective: { id: string; description: string };
  criterion: { id: string; description: string; required: boolean; expected: unknown };
  verifierId: BuiltinVerifierId;
  input: unknown;
  timeoutMs: number;
  context: {
    sessionId: string;
    correlationId: string;
    traceId: string;
    environmentSnapshotId: string;
    environmentSha256: string;
    capabilitySnapshotId: string;
    capabilitySha256: string;
    policySnapshotId: string;
    policySha256: string;
    policyDecisionId: string;
    artifactId: string;
    artifactSha256: string;
  };
  execution: {
    command: { executable: string; argv: string[]; cwd: string; normalized: string; timeoutMs: number };
    exit: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean };
    stdout: { attachmentId: string; bytes: Buffer };
    stderr: { attachmentId: string; bytes: Buffer };
    attachments?: Array<{ attachmentId: string; bytes: Buffer }>;
  };
}

export type ProbeOutcome =
  | { kind: 'pass'; observed: unknown; authoritySource: AuthoritySource; sourceRecordId: string }
  | { kind: 'fail'; observed: unknown; authoritySource: AuthoritySource; sourceRecordId: string }
  | { kind: 'crash'; error: Error; authoritySource: AuthoritySource; sourceRecordId: string };

export interface BuiltinProbePort {
  run(id: BuiltinVerifierId, input: unknown, signal: AbortSignal): Promise<ProbeOutcome>;
}

export interface VerificationResult {
  verificationId: string;
  status: VerificationStatus;
  observed: unknown;
  evidenceIds: string[];
  failureCode?: 'VERIFIER_ASSERTION_FAILED' | 'VERIFIER_TIMEOUT' | 'VERIFIER_CRASH' | 'VERIFIER_CANCELLED' | 'VERIFIER_AUDIT_SOURCE_MISMATCH';
  error?: GatewayError;
  /** W1-09 合同：authority 是审计元数据，不含 trusted 信任字段（trusted 是 legacy 调用方字面量兼容项，close 时剥离，不参与任何判定） */
  authority: { source: AuthoritySource; sourceRecordId: string; sourceStatus: VerificationStatus; trusted?: unknown };
}

export interface VerifierRegistry {
  verify(request: VerificationRequest, signal: AbortSignal): Promise<OperationResult<VerificationResult>>;
}
