// src/protocol/cancellableExecution.ts — 长驻协议请求的最小可取消执行契约
export interface CancellableExecution<T> {
  readonly completion: Promise<T>;
  cancel(): void;
}

export type CancellableOperation<T> = Promise<T> | CancellableExecution<T>;

export function asCancellableExecution<T>(operation: CancellableOperation<T>): CancellableExecution<T> {
  if (
    typeof operation === 'object'
    && operation !== null
    && 'completion' in operation
    && 'cancel' in operation
    && typeof operation.cancel === 'function'
  ) {
    return operation as CancellableExecution<T>;
  }
  return { completion: operation as Promise<T>, cancel() {} };
}
