// src/application/computer/computerWiring.ts — W3 Computer facade：生产端口组装（唯一共享管线接线层）
// Observe → Resolve → PDP → Authorize → Act → Re-observe → Verify → Evidence（顺序固定于 ComputerUseService）。
// 真实实现：observer/driver 委托 kernel ComputerUse（截图/robotjs 动作）；
// postconditions 复用内置 verifier registry（16 verifier，未实现者诚实 crash）；
// pdp/approvals/evidence 由装配层注入（审批桥/权限策略/落盘证据——缺失即 fail-closed，不假通过）。
import { randomUUID } from 'node:crypto';
import type { ComputerAction, ComputerActionContext } from '../../domain/computer/computerAction.js';
import { isHighImpactKind } from '../../domain/computer/computerAction.js';
import type { ComputerPipelinePorts } from './computerUseService.js';
import { BUILTIN_VERIFIER_DESCRIPTORS, type BuiltinProbePort, type ProbeOutcome } from '../../domain/quality/verifier.js';
import type { OperationResult } from '../../protocol/results.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface KernelComputerPort {
  observe(): Promise<{ png: Buffer; width: number; height: number; scale: number } | null>;
  act(action: unknown): Promise<string>;
}

export interface ComputerWiringInput {
  kernel: KernelComputerPort;
  emergencyStop: { active(): boolean };
  pdp?: ComputerPipelinePorts['pdp'];
  approvals?: ComputerPipelinePorts['approvals'];
  evidence?: ComputerPipelinePorts['evidence'];
  verifierProbe?: BuiltinProbePort;
  now?: () => string;
}

// 内置 verifier 的真实探测（与 BuildServiceWiring 同一诚实边界：未实现 verifier crash 绝不假 passed）
function verifierProbe(): BuiltinProbePort {
  return {
    async run(id, input, signal): Promise<ProbeOutcome> {
      const descriptor = BUILTIN_VERIFIER_DESCRIPTORS[id];
      const sourceRecordId = randomUUID();
      if (signal.aborted) {
        return { kind: 'crash', error: new Error('VERIFIER_CANCELLED'), authoritySource: descriptor.authoritySource, sourceRecordId };
      }
      const value = (input ?? {}) as Record<string, unknown>;
      if (id === 'file.exists') {
        const { existsSync } = await import('node:fs');
        const path = String(value.path ?? '');
        return { kind: existsSync(path) ? 'pass' : 'fail', observed: { exists: existsSync(path) }, authoritySource: 'filesystem-reader', sourceRecordId };
      }
      if (id === 'file.content') {
        const { readFileSync, existsSync } = await import('node:fs');
        const path = String(value.path ?? '');
        const matcher = String(value.matcher ?? '');
        if (!existsSync(path)) return { kind: 'fail', observed: { matched: false }, authoritySource: 'filesystem-reader', sourceRecordId };
        const content = readFileSync(path, 'utf8');
        return { kind: content.includes(matcher) ? 'pass' : 'fail', observed: { matched: content.includes(matcher) }, authoritySource: 'filesystem-reader', sourceRecordId };
      }
      return { kind: 'crash', error: new Error(`VERIFIER_UNIMPLEMENTED:${id}`), authoritySource: descriptor.authoritySource, sourceRecordId };
    },
  };
}

export function createProductionComputerPorts(input: ComputerWiringInput): ComputerPipelinePorts {
  const probe = input.verifierProbe ?? verifierProbe();
  return {
    emergencyStop: { active: () => input.emergencyStop.active() },
    observer: {
      observe: async (_target, _context, signal) => {
        if (signal.aborted) return fail('COMPUTER_OBSERVE_ABORTED');
        const shot = await input.kernel.observe();
        if (!shot) return fail('COMPUTER_OBSERVE_FAILED');
        // 透传观察值全部字段（re-observe 可能携带校验锚点如 path——postconditions verifier 依赖）
        return { ok: true as const, value: { ...shot } };
      },
    },
    resolver: {
      resolve: async (request, before) => ({
        ok: true as const,
        value: {
          effect: request.effect,
          verification: request.verification ?? { verifierId: 'file.exists', description: 'action observed' },
          action: { kind: request.kind, target: request.target, parameters: request.effect.parameters },
          before,
        },
      }),
    },
    pdp: input.pdp ?? {
      decide: async (effect, _context) => {
        // 无注入 PDP 时的高影响默认策略：高影响 kind 需要显式策略——fail-closed
        void effect;
        return fail('COMPUTER_PDP_UNAVAILABLE');
      },
    },
    approvals: input.approvals ?? {
      authorize: async () => fail('COMPUTER_APPROVAL_BRIDGE_UNAVAILABLE'),
    },
    driver: {
      act: async (action, _context, signal) => {
        if (signal.aborted) return fail('COMPUTER_ACT_ABORTED');
        const text = await input.kernel.act(action);
        if (typeof text === 'string' && text.startsWith('动作非法')) return fail('COMPUTER_ACTION_INVALID', { detail: text });
        // observed 合并动作参数——postconditions 的 verifier input 据此映射（file.exists/file.content 契约）
        const parameters = (action as { parameters?: Record<string, unknown> }).parameters ?? {};
        return { ok: true as const, value: { acted: true, observed: { result: text, ...parameters } } };
      },
    },
    postconditions: {
      verify: async (verification, _before, after, _context, signal) => {
        if (signal.aborted) return fail('COMPUTER_VERIFY_ABORTED');
        const id = verification.verifierId;
        if (!(id in BUILTIN_VERIFIER_DESCRIPTORS)) return fail('BUILD_VERIFIER_MAPPING_MISSING', { verifierId: id });
        // after 观察值直接作为 verifier input（file.exists/file.content 契约）
        const outcome = await probe.run(id as keyof typeof BUILTIN_VERIFIER_DESCRIPTORS, after, signal);
        if (outcome.kind === 'crash') return fail('COMPUTER_VERIFIER_UNIMPLEMENTED', { verifierId: id });
        return {
          ok: true as const,
          value: { status: outcome.kind === 'pass' ? ('passed' as const) : ('failed' as const), observed: outcome.observed },
        };
      },
    },
    evidence: input.evidence ?? {
      closeComputerAction: async () => fail('COMPUTER_EVIDENCE_UNAVAILABLE'),
    },
  };
}

/** 高影响判定（pdp 装配层的默认策略输入）：HIGH_IMPACT_KINDS 显式枚举 */
export const highImpactOf = (action: ComputerAction): boolean => isHighImpactKind(action.kind);
export const contextIdOf = (context: ComputerActionContext): string => `${context.runId}:${context.effectId}`;
