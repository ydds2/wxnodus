// src/application/tools/redlineGate.ts — W8-01：硬红线管线闸（PDP 前置独立复检）
// 生产 ToolExecutionPipeline 的 decide 阶段先于此闸：args 确定性序列化后匹配 HARD_REDLINES
// （permissions.ts 单一事实源）——命中即拒（HARD_REDLINE_DENIED），任何模式/策略/审批不可绕过；
// 这是把「任何模式不可绕过」从命令层声明变成管线级事实。
import { HARD_REDLINES } from '../../kernel/permissions.js';

export interface RedlineVerdict { id: string | null; desc?: string }

const serialize = (args: unknown): string => {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return String(args);
  }
};

/** 确定性红线判定：命中返回规则 id（首个命中即拒）；未命中 null */
export function checkRedlineViolation(args: unknown): RedlineVerdict {
  const text = serialize(args);
  if (!text) return { id: null };
  for (const rule of HARD_REDLINES) {
    rule.pattern.lastIndex = 0; // 全局正则防护（reuse 安全）
    if (rule.pattern.test(text)) return { id: rule.id, desc: rule.desc };
  }
  return { id: null };
}
