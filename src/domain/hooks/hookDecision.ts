// src/domain/hooks/hookDecision.ts — 安全关键 hook 的结构化决策（fail-closed）
// 只有干净退出 0 且无 DENY 输出才 allow；崩溃/超时/缺失/畸形（含非零退出带杂散输出）一律 deny。
export type HookExecutionOutcome =
  | { kind: 'ok'; output: string }
  | { kind: 'exited-nonzero'; output: string }
  | { kind: 'timeout' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export type SecurityHookDecision =
  | { allow: true; output?: string }
  | { allow: false; code: 'HOOK_EXECUTION_FAILED' | 'HOOK_TIMEOUT' | 'HOOK_MALFORMED'; output?: string };

export function decideSecurityHook(outcome: HookExecutionOutcome): SecurityHookDecision {
  if (outcome.kind === 'ok') {
    return hasDenyLine(outcome.output) ? { allow: false, code: 'HOOK_MALFORMED', output: outcome.output } : { allow: true, output: outcome.output };
  }
  if (outcome.kind === 'timeout') return { allow: false, code: 'HOOK_TIMEOUT' };
  if (outcome.kind === 'missing') return { allow: false, code: 'HOOK_EXECUTION_FAILED' };
  if (outcome.kind === 'error') return { allow: false, code: 'HOOK_EXECUTION_FAILED' };
  // 非零退出：无论输出是否带 DENY，hook 未完成合法协议 → fail closed
  return { allow: false, code: hasDenyLine(outcome.output) ? 'HOOK_MALFORMED' : 'HOOK_MALFORMED', output: outcome.output };
}

export function hasDenyLine(output: string): boolean {
  return output.startsWith('DENY') || /\nDENY/.test(output);
}
