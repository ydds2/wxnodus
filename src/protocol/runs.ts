// src/protocol/runs.ts — Run 终态协议（CompletionGate 唯一信任的状态集）
export const RUN_FINAL_STATUSES = ['succeeded', 'failed', 'blocked', 'incomplete', 'inconclusive', 'cancelled'] as const;
export type RunFinalStatus = (typeof RUN_FINAL_STATUSES)[number];

export function isRunFinalStatus(value: string): value is RunFinalStatus {
  return (RUN_FINAL_STATUSES as readonly string[]).includes(value);
}
