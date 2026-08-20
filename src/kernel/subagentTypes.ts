// src/kernel/subagentTypes.ts — 子代理分型（supremacy 3.x ④ 满格第四件，2026-08-18）
// 机制参考：crush/codex 子代理分型（探索/编码/审查等类型化任务面）——实现原创。
// 分型：explore（只读探索）/ coder（编码执行，全工具默认面）/ review（只读审查）。
// 类型定义经 delegate 工具 kind 参数传入 spawnSubagent：systemPromptOverride + 工具白名单
// （白名单模式=除列出工具外全部排除——只读型天然无写能力，比默认「排除危险工具」更收敛）。
// 未知/未传 kind → null（调用方保持既有默认只读子代理——零漂移）。
import type { Mode } from './permissions.js';
import type { RunContext } from '../protocol/runs.js';

export type SubagentKind = 'explore' | 'coder' | 'review';

export interface SubagentDefinition {
  systemPromptOverride?: string;
  mode?: Mode;
  tools?: string[];
  /** 仅覆盖此子代理的模型设置；不得写回父 Agent 或持久配置。 */
  model?: string;
  baseURL?: string;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  context?: RunContext;
  /** 独立子会话名；不改变继承的顶层 Run 身份。 */
  sessionId?: string;
}

export interface SubagentTypeDef {
  kind: SubagentKind;
  label: string;
  systemPrompt: string;
  /** 工具白名单（undefined=默认面）；只读型显式列出只读工具 */
  tools?: string[];
}

/** 只读工具面（与 permissions 的 danger=false 语义一致：无任何写/执行能力） */
export const READONLY_SUBAGENT_TOOLS = [
  'fs_read', 'ls', 'grep', 'find_files', 'memory_search', 'repo_map',
  'lsp_diagnostics', 'lsp_hover', 'lsp_definition', 'skill_load',
  'tool_search', 'command_search', 'clarify', 'ask_user', 'todo',
] as const;

export const SUBAGENT_TYPES: Record<SubagentKind, SubagentTypeDef> = {
  explore: {
    kind: 'explore',
    label: '探索',
    systemPrompt: '你是探索子代理：只读调查并汇报结论——绝不修改任何文件。用最少工具回答；结论 ≤400 字，附证据（文件:行号）。',
    tools: [...READONLY_SUBAGENT_TOOLS],
  },
  coder: {
    kind: 'coder',
    label: '编码',
    systemPrompt: '你是编码子代理：独立完成实现任务——用 apply_patch/fs_edit 修改、bash 跑测试验证；报告改动清单与验证结果。',
  },
  review: {
    kind: 'review',
    label: '审查',
    systemPrompt: '你是审查子代理：只读复查——检查逻辑错误/安全问题/与既有风格的一致性；输出分级问题清单（严重/警告/建议），不修改任何文件。',
    tools: [...READONLY_SUBAGENT_TOOLS],
  },
};

export const SUBAGENT_KINDS = Object.keys(SUBAGENT_TYPES) as SubagentKind[];

/** kind → 类型定义（未知/空 → null——调用方回退默认只读子代理，零漂移） */
export function resolveSubagentDef(kind: string | null | undefined): SubagentTypeDef | null {
  const k = String(kind ?? '').trim().toLowerCase();
  return (SUBAGENT_KINDS as string[]).includes(k) ? SUBAGENT_TYPES[k as SubagentKind] : null;
}
