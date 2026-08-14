// src/application/hooks/securityHookAdapter.ts — P0-06：安全关键 hook 决策的 application 边界
// 现代组合根与 legacy runner 共用同一 domain 决策函数；不引入平行算法或自建 allow/deny 逻辑。
export { decideSecurityHook, hasDenyLine } from '../../domain/hooks/hookDecision.js';
export type { HookExecutionOutcome, SecurityHookDecision } from '../../domain/hooks/hookDecision.js';
