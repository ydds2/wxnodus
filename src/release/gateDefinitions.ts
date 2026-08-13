// src/release/gateDefinitions.ts — Wave 0 Gate scope（唯一 scope 定义）
import type { GateId } from './evidenceTypes.js';

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
