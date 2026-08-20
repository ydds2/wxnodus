// src/protocol/errors.ts — 稳定错误码协议（控制流只依赖 code，不依赖中英文文本）
export type GatewayErrorCode =
  | 'EVENT_TIMESTAMP_INVALID'
  | 'EVENT_LIFECYCLE_SESSION_REQUIRED'
  | 'EVENT_LIFECYCLE_RUN_REQUIRED'
  | 'EVENT_LIFECYCLE_TURN_REQUIRED'
  | 'EVENT_SECRET_REDACTION_REQUIRED'
  | 'EVENT_SECRET_RETENTION_REQUIRED'
  | 'GATEWAY_METHOD_UNSUPPORTED';

export interface GatewayError {
  code: GatewayErrorCode | (string & {});
  message: string;
  messageKey: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  causeId?: string;
}

export function gatewayError(
  code: GatewayError['code'],
  message: string,
  messageKey: string,
  options: Pick<GatewayError, 'retryable' | 'details' | 'causeId'> = { retryable: false },
): GatewayError {
  return { code, message, messageKey, retryable: options.retryable, details: options.details, causeId: options.causeId };
}
