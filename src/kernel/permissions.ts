// src/kernel/permissions.ts — L2-3 权限模式（危险分级 + 硬红线）
// 设计（参考 Claude Code 6 模式 + Codex approval policy + 安全底线）：
//  模式：smart(默认：只读放行/危险确认) / auto(非危险全放) / manual(危险必确认)
//        plan(只读研究+计划审批) / yolo(除红线全放)
//  硬红线：任何模式不可绕过（rm -rf /、格式化、diskpart、force push、iex 注入、管道执行）
export type Mode = 'smart' | 'auto' | 'manual' | 'plan' | 'yolo';
export type Verdict = 'approve' | 'reject' | 'confirm' | 'plan';

export interface Redline { pattern: RegExp; desc: string }

// 硬红线清单（任何模式不可绕过——安全底线）
export const HARD_REDLINES: Redline[] = [
  { pattern: /rm\s+-rf\s+\/|rm\s+-rf\s+[a-zA-Z]:\\/i, desc: '删除根目录' },
  { pattern: /\bformat\s+[a-zA-Z]:/i, desc: '格式化磁盘' },
  { pattern: /\bdiskpart\b/i, desc: '磁盘分区操作' },
  { pattern: /git\s+push\s+--force/i, desc: '强制推送' },
  { pattern: /\biex\b|Invoke-Expression/i, desc: 'PowerShell 注入执行' },
  { pattern: /\|\s*(sh|bash|pwsh|powershell)\b/i, desc: '管道执行' },
  { pattern: /del\s+\/f\s+\/s\s+[a-zA-Z]:\\/i, desc: '递归删除系统盘' },
  { pattern: /reg\s+delete\s+HKLM/i, desc: '修改系统注册表' },
];

function hitRedline(tool: string, args: Record<string, any>): Redline | null {
  const text = [tool, ...Object.values(args ?? {})].map(String).join(' ');
  for (const r of HARD_REDLINES) if (r.pattern.test(text)) return r;
  return null;
}

const READONLY_TOOLS = new Set(['fs_read', 'ls', 'grep', 'http_get', 'memory_write', 'ask_user', 'skill_search', 'skill_load', 'code_symbols', 'repo_map', 'rag_search', 'hole_recall']);

export function modeVerdict(mode: Mode, tool: string, args: Record<string, any>): Verdict {
  // 1. 硬红线：任何模式不可绕过
  const red = hitRedline(tool, args);
  if (red) return 'reject';
  // 2. 模式语义
  switch (mode) {
    case 'yolo': return 'approve';
    case 'plan': return 'plan'; // 只读研究，所有动作走计划审批
    case 'auto': return 'approve';
    case 'manual': return READONLY_TOOLS.has(tool) ? 'approve' : 'confirm';
    case 'smart':
    default:
      return READONLY_TOOLS.has(tool) ? 'approve' : 'confirm';
  }
}
