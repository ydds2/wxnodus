// src/domain/quality/verification.ts — verifier 端口：输入不可信，结果不带 caller-assignable trust
import type { AuthoritySource, VerificationStatus } from './evidence.js';
import type { OperationResult } from '../../protocol/results.js';

export interface VerificationRequest { id: string; verifierId: string; input: unknown }
export interface VerificationResult { verificationId: string; status: VerificationStatus; observed: unknown; failureCode?: string;
  authority: { source: AuthoritySource; sourceRecordId: string; sourceStatus: VerificationStatus } }
export interface VerifierRegistry { verify(request: VerificationRequest, signal: AbortSignal): Promise<OperationResult<VerificationResult>> }
