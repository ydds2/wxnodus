// src/kernel/permissions.ts — L2-3 权限模式（危险分级 + 硬红线）
// 设计（参考 Claude Code 6 模式 + Codex approval policy + hermes HARDLINE 结构）：
//  模式：smart(默认：只读/非危险放行、危险确认) / auto(危险也自动放行，除红线)
//        manual(非只读必确认) / plan(只读放行、非只读计划审批) / yolo(除红线全放)
//  硬红线：任何模式不可绕过——扩展自 hermes 的 HARDLINE/DANGEROUS_PATTERNS 结构
export type Mode = 'smart' | 'auto' | 'manual' | 'plan' | 'yolo';
export type Verdict = 'approve' | 'reject' | 'confirm' | 'plan';

export interface Redline { pattern: RegExp; desc: string }

// 硬红线清单（任何模式不可绕过——安全底线；修复 F13：扩展覆盖）
export const HARD_REDLINES: Redline[] = [
  // 文件系统破坏
  { pattern: /rm\s+-rf\s+\/|rm\s+-rf\s+[a-zA-Z]:\\|rm\s+-rf\s+~(?:\s|$)/i, desc: '删除根目录/家目录' },
  { pattern: /rm\s+-rf\s+(?:\$HOME|%USERPROFILE%|\/home\/|\/root)(?:\s|$)/i, desc: '删除家目录（变量变体）' },
  { pattern: /\bformat\s+[a-zA-Z]:/i, desc: '格式化磁盘' },
  { pattern: /\bdiskpart\b/i, desc: '磁盘分区操作' },
  { pattern: /\bmkfs(?:\s|$)/i, desc: '创建文件系统' },
  { pattern: /\bdd\s+.*\bof=\/dev\/(?:sd|nvme|hd)/i, desc: 'dd 写入裸设备' },
  { pattern: /del\s+\/f\s+\/s\s+[a-zA-Z]:\\|Remove-Item\s+-Recurse\s+-Force\s+[a-zA-Z]:\\/i, desc: '递归删除系统盘' },
  // 系统/进程破坏
  { pattern: /\breg\s+delete\s+HKLM/i, desc: '修改系统注册表' },
  { pattern: /\b(shutdown|reboot|poweroff|halt|init\s+0|telinit\s+0|systemctl\s+(poweroff|reboot))\b/i, desc: '关机/重启' },
  { pattern: /\bkill\s+-9?\s+-1\b|:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/i, desc: 'kill -1 / fork bomb' },
  // 凭据/注入
  { pattern: /\biex\b|Invoke-Expression|Format-Volume/i, desc: 'PowerShell 注入执行' },
  { pattern: /\|\s*(sh|bash|pwsh|powershell)\b/i, desc: '管道执行' },
  { pattern: /git\s+push\s+--force(?:\s|$)/i, desc: '强制推送（--force-with-lease 不误伤）' },
];

function hitRedline(tool: string, args: Record<string, any>): Redline | null {
  const text = [tool, ...Object.values(args ?? {})].map(String).join(' ');
  for (const r of HARD_REDLINES) if (r.pattern.test(text)) return r;
  return null;
}

// 敏感路径写保护（修复 F13）：fs_write/fs_edit 写入凭据/配置/密钥文件直接拒绝
const SENSITIVE_WRITE = /(^|[\\/])(\.bashrc|\.zshrc|\.profile|\.bash_profile|\.ssh[\\/].*|\.env|\.env\.local|id_rsa|id_ed25519|authorized_keys|known_hosts|\.git[\\/]config|\.npmrc|\.pypirc)(\s|$)/i;

// 只读工具名单（危险语义修复 F12：与 tools.danger 单一事实来源——danger:false 且无副作用的工具）
// 注意：memory_write/http_get 有副作用/外联，移出只读名单
const READONLY_TOOLS = new Set(['fs_read', 'ls', 'grep', 'skill_search', 'skill_load', 'code_symbols', 'repo_map', 'rag_search', 'hole_recall']);

export function modeVerdict(mode: Mode, tool: string, args: Record<string, any>, toolDanger?: boolean): Verdict {
  // 1. 硬红线：任何模式不可绕过
  const red = hitRedline(tool, args);
  if (red) return 'reject';
  // 2. 敏感路径写保护（fs_write/fs_edit 的 path 参数）
  if (tool === 'fs_write' || tool === 'fs_edit') {
    const path = String(args?.path ?? '');
    if (SENSITIVE_WRITE.test(path)) return 'reject';
  }
  const isDanger = toolDanger ?? !READONLY_TOOLS.has(tool);
  // 3. 模式语义
  switch (mode) {
    case 'yolo': return 'approve';
    case 'plan': return READONLY_TOOLS.has(tool) ? 'approve' : 'plan'; // 修复：只读研究自由，非只读计划审批
    case 'auto': return 'approve';
    case 'manual': return isDanger ? 'confirm' : 'approve';
    case 'smart':
    default:
      return isDanger ? 'confirm' : 'approve';
  }
}
