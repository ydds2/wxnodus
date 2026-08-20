// src/kernel/completionClaim.ts — 确定性完成声明判定（KF-023/024 修复核心）
// 模型文本自述完成（「完成了」/「[GOAL_DONE]」/done）只是候选——须经验证副作用（verified effects）
// 或 verifier 才能 ok；零证据的完成声明 → incomplete（绝不从文本推导 succeeded）。
// 保守匹配：只认明确完成声明；「读完了」「一次完成」等普通叙事不误伤（聊天语义保持）。
const COMPLETION_CLAIM_PATTERNS: RegExp[] = [
  // 完成了 / 已完成 / 已经完成了 / 任务完成 / 完成（可选任务前缀 + 可选完成态前缀 + 可选「了」+ 句末标点）
  /^(?:任务)?(?:已经|已)?完成了?[。！!….\s]*$/i,
  /^(done|finished)[.!]?\s*$/i,
];

export const GOAL_DONE_MARK = '[GOAL_DONE]';

export function isCompletionClaim(text: string): boolean {
  const t = text.trim();
  if (t.includes(GOAL_DONE_MARK)) return true;
  return COMPLETION_CLAIM_PATTERNS.some(p => p.test(t));
}
