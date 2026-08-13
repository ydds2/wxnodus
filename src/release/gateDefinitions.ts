// src/release/gateDefinitions.ts — Wave 0 Gate scope（唯一 scope 定义）+ Wave 1 Gate 求值（W1-11）
import type { GateId } from './evidenceTypes.js';
import type { VerifiedEvidenceReceipt } from '../domain/quality/evidence.js';
import type { ReviewerAttestationVerifier, VerifiedReviewerAttestationReceipt } from '../domain/quality/review.js';
import type { FileEvidenceStore } from '../infrastructure/quality/fileEvidenceStore.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok } from '../protocol/results.js';

export interface RequiredGateScope {
  mode: 'required';
  runnerIds: string[];
}

export interface NotApplicableGateScope {
  mode: 'na';
  reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE';
}

export type GateScope = RequiredGateScope | NotApplicableGateScope;

export const WAVE_0_SCOPE: Record<GateId, GateScope> = {
  A: { mode: 'required', runnerIds: ['build', 'typecheck'] },
  B: { mode: 'required', runnerIds: ['test-discovery', 'test-all', 'known-failures'] },
  C: { mode: 'required', runnerIds: ['recovery-drill'] },
  D: { mode: 'na', reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE' },
  E: { mode: 'na', reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE' },
  F: { mode: 'required', runnerIds: ['policy-manifest-check', 'policy-fixture-tests'] },
  G: { mode: 'na', reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE' },
  H: { mode: 'na', reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE' },
  I: { mode: 'na', reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE' },
};

export interface GateRunnerCommand {
  executable: string;
  args: string[];
}

/** runner id → 可执行命令（argv 数组，绝不拼 shell 字符串） */
export const WAVE_0_RUNNERS: Record<string, GateRunnerCommand> = {
  build: { executable: 'npm.cmd', args: ['run', 'build'] },
  typecheck: { executable: 'npm.cmd', args: ['run', 'typecheck'] },
  'test-discovery': { executable: 'npm.cmd', args: ['run', 'check:test-discovery'] },
  'test-all': { executable: 'npm.cmd', args: ['run', 'test:all'] },
  'known-failures': { executable: 'npm.cmd', args: ['run', 'test:known-failures'] },
  'recovery-drill': { executable: 'npm.cmd', args: ['run', 'drill:wave0-recovery'] },
  'policy-manifest-check': { executable: 'node', args: ['scripts/generate-policy-manifest.mjs', '--check'] },
  'policy-fixture-tests': { executable: 'npm.cmd', args: ['exec', '--', 'vitest', 'run', 'tests/policy-manifest.test.ts'] },
};

/** Gate → 需求 ID 映射（Wave 0 scope） */
export const WAVE_0_GATE_REQUIREMENTS: Record<GateId, Array<`R${string}`>> = {
  A: ['R01', 'R10', 'R11', 'R12', 'R17', 'R18'],
  B: ['R10', 'R15', 'R16', 'R18', 'R20'],
  C: ['R09', 'R10', 'R14', 'R18'],
  D: ['R10'],
  E: ['R07', 'R08'],
  F: ['R10', 'R15', 'R16'],
  G: ['R15', 'R19', 'R20'],
  H: ['R17', 'R18'],
  I: ['R18'],
};

export const WAVE_0_PROFILES = ['core', 'standard', 'full-local-ai'] as const;
export const WAVE_0_PLATFORMS = ['windows'] as const;

/** N/A gate → 不可达 capability ID（与 unreachable-capability fixture 一一对应） */
export const WAVE_0_UNREACHABLE: Record<GateId, string[]> = {
  A: [],
  B: [],
  C: [],
  D: ['gate-d-functional-scenario'],
  E: ['voice-runtime', 'computer-use'],
  F: [],
  G: ['completion-gate-decision'],
  H: ['distribution-installer'],
  I: ['secondary-platform-matrix'],
};

// ── Wave 2 Gate 稳定 ID（W2-11）：runner 只消费 capability snapshot/evidence，不重新 probe 本机 ──
export const WAVE_2_GATE_IDS = ['W2_MIGRATION_DRILL', 'W2_SCRIPT_MAPPING', 'W2_UNAVAILABLE_SURFACES'] as const;
export type Wave2GateId = typeof WAVE_2_GATE_IDS[number];

// ── Wave 3 scoped Gate（W3-11）：精确 test manifest（禁止目录通配）+ 只含 A/B/C/D/E/F/G 七片；H/I 严格 N/A ──
export const WAVE3_TEST_FILES = [
  'tests/unit/quality/verifierRegistry.contract.test.ts',
  'tests/integration/evidenceAuthorityConflict.test.ts',
  'tests/integration/failurePropagation.test.ts',
  'tests/unit/tui/reducer-projector.contract.test.ts',
  'tests/contract/gatewayClient.contract.test.ts',
  'tests/integration/frontendParity.test.ts',
  'tests/unit/voice/audioDeviceService.test.ts',
  'tests/unit/voice/voice-domain.contract.test.ts',
  'tests/unit/voice/wavWriter.test.ts',
  'tests/integration/voiceSession.test.ts',
  'tests/integration/voiceHeadlessParity.test.ts',
  'tests/failure/voiceWorkerFailure.test.ts',
  'tests/unit/computer/highImpactApproval.test.ts',
  'tests/unit/computer/postcondition.test.ts',
  'tests/unit/computer/driverContracts.test.ts',
  'tests/integration/computerUsePipeline.test.ts',
  'tests/integration/computerFrontendParity.test.ts',
  'tests/integration/emergencyStop.test.ts',
  'tests/integration/browserIsolation.test.ts',
  'tests/failure/driverFallback.test.ts',
  'tests/unit/build/buildContracts.test.ts',
  'tests/integration/buildService.test.ts',
  'tests/integration/buildRestartReadback.test.ts',
  'tests/integration/buildEvidenceDecision.test.ts',
  'tests/failure/buildVerifierFailure.test.ts',
  'tests/contract/pty.contract.test.ts',
  'tests/failure/ptyLifecycle.test.ts',
  'tests/contract/windowsRunnerProvisioning.contract.test.ts',
  'tests/integration/wave3-current-migration-recovery.test.ts',
  'tests/integration/wave3-headless-e2e.test.ts',
  'tests/integration/wave3-legacy-bypass.test.ts',
  'tests/integration/wave3-gate-scope.test.ts',
] as const;

export const WAVE3_GATE_DEFINITIONS = [
  { id: 'A-W3', wave: 3, command: ['npm.cmd', ['run', 'gate:wave3-a']], owner: 'wave3' },
  { id: 'B-W3', wave: 3, command: ['npm.cmd', ['exec', '--', 'vitest', 'run', ...WAVE3_TEST_FILES]], owner: 'wave3' },
  { id: 'C-W3', wave: 3, command: ['npm.cmd', ['run', 'drill:wave3-recovery']], owner: 'wave3' },
  { id: 'D-W3', wave: 3, command: ['npm.cmd', ['run', 'test:wave3-headless']], owner: 'wave3' },
  { id: 'E-W3', wave: 3, command: ['npm.cmd', ['run', 'test:windows-real']], owner: 'wave3' },
  { id: 'F-W3', wave: 3, command: ['npm.cmd', ['run', 'test:wave3-security']], owner: 'wave3' },
  { id: 'G-W3', wave: 3, command: ['npm.cmd', ['run', 'gate:completion']], owner: 'wave3' },
] as const;

// ── Wave 1 Gate 求值（W1-11）：只接受 W1-09 verifier 实例签发的 receipt ──
export interface Wave1GateInput { id: 'A' | 'B' | 'C' | 'D' | 'F' | 'G'; required: boolean;
  evidence: VerifiedEvidenceReceipt[]; reviewer?: VerifiedReviewerAttestationReceipt;
  notApplicable?: { requirementId: string; profile: string; platform: string; unreachableEvidenceIds: string[] } }

export function evaluateWave1Gates(gates: Wave1GateInput[], trust: { evidenceStore: FileEvidenceStore; reviewerVerifier: ReviewerAttestationVerifier }) {
  for (const gate of gates) {
    if (gate.notApplicable) {
      if (!gate.notApplicable.requirementId || !gate.notApplicable.profile || !gate.notApplicable.platform || !gate.notApplicable.unreachableEvidenceIds.length)
        return err(gatewayError('GATE_NOT_APPLICABLE_INVALID', gate.id, 'gate.na.invalid'));
      continue;
    }
    if (!gate.evidence.length || !gate.evidence.every(item => trust.evidenceStore.owns(item)))
      return err(gatewayError('GATE_EVIDENCE_UNTRUSTED', gate.id, 'gate.evidence.untrusted'));
    if (gate.id === 'G' && (!gate.reviewer || !trust.reviewerVerifier.owns(gate.reviewer)))
      return err(gatewayError('GATE_REVIEW_UNTRUSTED', gate.id, 'gate.review.untrusted'));
    if (gate.required && gate.evidence.some(item => item.record.criteria.some(c => c.required && c.status !== 'passed')))
      return err(gatewayError('GATE_REQUIRED_FAILED', gate.id, 'gate.required.failed'));
  }
  return ok({ passed: true, gateIds: gates.map(gate => gate.id) });
}
