// src/kernel/loopJudge.ts — LLM 辅助循环检测（supremacy 1.5 / 缺陷 A-05 落地，2026-08-18）
// 机制参考：gemini 置信度判空转（签名级检测之上加一层语义判断）——实现原创。
// 现状：签名级检测（agent.ts）把「同工具+同参数+同输出」判为重复——但合法轮询
// （构建轮询/重试/分页续读）也可能短期重复。LLM 辅助：重复达到提醒阈值时，
// 单轮调用模型语义判断「真死循环（loop）」还是「合法重复（progress）」：
//   - loop → 提前硬停（显式失败文案，不再等到硬停阈值空烧 token）
//   - progress → 复位该签名计数（合法轮询继续跑，下次再爬到阈值会重新判断）
//   - unknown/失败 → 回退既有静态路径（提醒→硬停），行为不劣于原版
// settings.loopJudge=true 开启（默认关）；判定走主模型单轮 callModelOnce（CLI 注入）。
export interface LoopEvidence {
  name: string;
  args: string;
  /** 输出头部（截断——判据够用且省 token） */
  outputHead: string;
}

export type LoopVerdict = 'loop' | 'progress' | 'unknown';

/** 判定提示词：给足证据（重复次数 + 最近 N 次调用的工具/参数/输出头部），要求单词语义判定 */
export function buildLoopJudgePrompt(evidence: LoopEvidence[], repeatCount: number): { system: string; user: string } {
  const lines = evidence.slice(-3).map((e, i) =>
    `${i + 1}. 工具 ${e.name}｜参数 ${e.args.slice(0, 200)}｜输出头部：${e.outputHead.slice(0, 200)}`,
  ).join('\n');
  return {
    system: '你是循环判定器。agent 在连续重复相同的工具调用（签名一致）。判断这是「任务无进展的死循环」还是「合法重复操作」（如构建轮询、重试、分页续读、等待类轮询）。只输出一个词：loop（死循环，应立即停止）或 progress（合法重复，继续）。无法判断输出 unknown。',
    user: `当前相同调用已重复 ${repeatCount} 次。最近证据：\n${lines}`,
  };
}

/** 宽容解析（V4 P5-4 整词锚定）：精确词 → 整词边界匹配；两词齐现=歧义 → unknown
 * （回退静态安全路径——此前 includes 子串判定，「不是 loop，是 progress」这类解释性
 * 回答含两词且 loop 先命中 → 误判 loop 误杀合法轮询） */
export function parseLoopVerdict(text: string | null | undefined): LoopVerdict {
  const t = String(text ?? '').trim().toLowerCase();
  if (t === 'loop') return 'loop';
  if (t === 'progress') return 'progress';
  const hasLoop = /\bloop\b/.test(t);
  const hasProgress = /\bprogress\b/.test(t);
  if (hasLoop && !hasProgress) return 'loop';
  if (hasProgress && !hasLoop) return 'progress';
  return 'unknown'; // 两词齐现/都没有 → 歧义回退
}
