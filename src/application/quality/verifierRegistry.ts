// src/application/quality/verifierRegistry.ts — 可信 verifier 注册表（结果 authority 不暴露 trust 字段）
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import type { VerificationResult, VerifierRegistry } from '../../domain/quality/verification.js';

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
