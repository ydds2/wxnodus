// src/application/quality/verifierRegistry.ts — 可信 verifier 注册表（W1-09 createTrustedVerifierRegistry + W3-01 createBuiltinVerifierRegistry）
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import type { OperationResult } from '../../protocol/results.js';
import type { VerificationResult, VerifierRegistry } from '../../domain/quality/verification.js';
import {
  BUILTIN_VERIFIER_DESCRIPTORS,
  type BuiltinProbePort,
  type VerificationRequest,
  type VerificationResult as BuiltinVerificationResult,
  type VerifierRegistry as BuiltinVerifierRegistry,
} from '../../domain/quality/verifier.js';

const failure = (code: string, message: string): OperationResult<never> => ({
  ok: false,
  error: { code, message, messageKey: code, retryable: false },
});

/** W3-01：16 个内置 verifier 的稳定注册表——probe 注入，authority 冲突 → VERIFIER_AUDIT_SOURCE_MISMATCH（fail closed） */
export function createBuiltinVerifierRegistry(probe: BuiltinProbePort): BuiltinVerifierRegistry {
  return {
    async verify(request: VerificationRequest, signal: AbortSignal): Promise<OperationResult<BuiltinVerificationResult>> {
      const descriptor = BUILTIN_VERIFIER_DESCRIPTORS[request.verifierId];
      if (!descriptor) return failure('VERIFIER_NOT_FOUND', request.verifierId);
      if (!request.input || typeof request.input !== 'object' ||
          descriptor.requiredInputKeys.some(key => !Object.hasOwn(request.input as object, key))) {
        return failure('VERIFIER_INPUT_INVALID', request.verifierId);
      }
      if (signal.aborted) {
        return { ok: true, value: {
          verificationId: request.id,
          status: 'cancelled',
          observed: null,
          evidenceIds: [],
          failureCode: 'VERIFIER_CANCELLED',
          authority: { source: 'process-supervisor', sourceRecordId: request.id, sourceStatus: 'cancelled' },
        } };
      }

      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('VERIFIER_TIMEOUT')), request.timeoutMs);
        });
        const outcome = await Promise.race([probe.run(request.verifierId, request.input, signal), timeout]);
        if (outcome.authoritySource !== descriptor.authoritySource) {
          return { ok: true, value: {
            verificationId: request.id,
            status: 'inconclusive',
            observed: null,
            evidenceIds: [],
            failureCode: 'VERIFIER_AUDIT_SOURCE_MISMATCH',
            authority: { source: descriptor.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'inconclusive' },
          } };
        }
        if (outcome.kind === 'pass') {
          return { ok: true, value: {
            verificationId: request.id,
            status: 'passed',
            observed: outcome.observed,
            evidenceIds: [],
            authority: { source: outcome.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'passed' },
          } };
        }
        if (outcome.kind === 'fail') {
          return { ok: true, value: {
            verificationId: request.id,
            status: 'failed',
            observed: outcome.observed,
            evidenceIds: [],
            failureCode: 'VERIFIER_ASSERTION_FAILED',
            authority: { source: outcome.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'failed' },
          } };
        }
        return { ok: true, value: {
          verificationId: request.id,
          status: 'inconclusive',
          observed: { error: outcome.error.message },
          evidenceIds: [],
          failureCode: 'VERIFIER_CRASH',
          authority: { source: outcome.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'inconclusive' },
        } };
      } catch (error) {
        const timedOut = error instanceof Error && error.message === 'VERIFIER_TIMEOUT';
        return { ok: true, value: {
          verificationId: request.id,
          status: 'inconclusive',
          observed: null,
          evidenceIds: [],
          failureCode: timedOut ? 'VERIFIER_TIMEOUT' : 'VERIFIER_CRASH',
          authority: { source: 'process-supervisor', sourceRecordId: request.id, sourceStatus: 'inconclusive' },
        } };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

type Verifier = (input: unknown, signal: AbortSignal) => Promise<VerificationResult>;
export function createTrustedVerifierRegistry(probe: { fileExists(path: string): Promise<boolean> }): VerifierRegistry {
  const verifiers = new Map<string, Verifier>();
  const register = (id: string, verifier: Verifier) => { if (verifiers.has(id)) throw Object.assign(new Error('duplicate'), { code: 'VERIFIER_DUPLICATE_ID' }); verifiers.set(id, verifier); };
  register('command.exit-code', async (input, signal) => {
    if (signal.aborted) return { verificationId: '', status: 'cancelled', observed: null, failureCode: 'VERIFIER_CANCELLED', authority: { source: 'process-supervisor', sourceRecordId: 'cancelled', sourceStatus: 'cancelled' } };
    const value = input as { actual?: unknown; expected?: unknown }; if (typeof value?.actual !== 'number' || typeof value?.expected !== 'number') throw Object.assign(new Error('invalid'), { code: 'VERIFIER_INPUT_INVALID' });
    const passed = value.actual === value.expected; return { verificationId: '', status: passed ? 'passed' : 'failed', observed: value.actual, failureCode: passed ? undefined : 'VERIFIER_ASSERTION_FAILED', authority: { source: 'process-supervisor', sourceRecordId: `exit:${value.actual}`, sourceStatus: passed ? 'passed' : 'failed' } };
  });
  register('file.exists', async (input, signal) => {
    if (signal.aborted) return { verificationId: '', status: 'cancelled', observed: null, failureCode: 'VERIFIER_CANCELLED', authority: { source: 'filesystem-reader', sourceRecordId: 'cancelled', sourceStatus: 'cancelled' } };
    const path = (input as { path?: unknown })?.path; if (typeof path !== 'string') throw Object.assign(new Error('invalid'), { code: 'VERIFIER_INPUT_INVALID' });
    const exists = await probe.fileExists(path); return { verificationId: '', status: exists ? 'passed' : 'failed', observed: exists, failureCode: exists ? undefined : 'VERIFIER_ASSERTION_FAILED', authority: { source: 'filesystem-reader', sourceRecordId: path, sourceStatus: exists ? 'passed' : 'failed' } };
  });
  return { async verify(request, signal) {
    const verifier = verifiers.get(request.verifierId); if (!verifier) return err(gatewayError('VERIFIER_NOT_FOUND', request.verifierId, 'verifier.notFound'));
    try { return ok({ ...(await verifier(request.input, signal)), verificationId: request.id }); }
    catch (error) { if ((error as { code?: string }).code === 'VERIFIER_INPUT_INVALID') return err(gatewayError('VERIFIER_INPUT_INVALID', 'Invalid verifier input', 'verifier.input.invalid')); return ok({ verificationId: request.id, status: 'inconclusive', observed: null, failureCode: 'VERIFIER_CRASH', authority: { source: 'process-supervisor', sourceRecordId: request.id, sourceStatus: 'inconclusive' } }); }
  } };
}
