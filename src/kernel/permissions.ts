// src/kernel/permissions.ts — L2-3 权限模式（危险分级 + 硬红线）
// 设计（参考 Claude Code 6 模式 + Codex approval policy + hermes HARDLINE 结构）：
//  模式（对齐 Claude Code 五模式体系）：
//    smart 更改前确认（默认）：只读放行、写/网络/危险确认
//    auto  自动编辑：文件编辑（fs_write/fs_edit）自动接受；bash 按分级、危险确认
//    goal  loop-goal：自动编辑语义 + agent 层目标驱动自主循环（Ralph 同款）
//    manual 全量确认（只读也确认）
//    plan 计划模式：只读放行、非只读计划审批
//    yolo 完全访问：除红线全放
//  硬红线：任何模式不可绕过——扩展自 hermes 的 HARDLINE/DANGEROUS_PATTERNS 结构
export type Mode = 'smart' | 'auto' | 'manual' | 'plan' | 'yolo' | 'goal';
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

// ── bash 命令分级（参考 Claude Code read-only 命令白名单 + Kimi auto_approve_actions）──
// 只读命令（pwd/ls/cat/git status 等）smart/auto/plan 下直接放行不弹确认；
// 多命令串（&&/;/|/重定向）逐段分类取最保守等级——`echo hi && rm -rf x` 必为 danger
export type BashCategory = 'readonly' | 'write' | 'network' | 'danger';
const BASH_READONLY = /^(pwd|ls|dir|cd|cat|head|tail|less|more|wc|grep|find|which|where|type|echo|date|time|env|uname|whoami|hostname|true|false|git\s+(status|log|diff|show|branch|remote|rev-parse|config|ls-files|stash\s+list|tag\s+-l))(?:[\s]|$)/i;
const BASH_NETWORK = /^(curl|wget|ping|nslookup|netstat|tracert|ssh\s+-T|git\s+ls-remote)(?:[\s]|$)/i;
// 破坏性命令（危险级，与 HARD_REDLINES 互补——红线管全局模式，这里管命令首词）
const BASH_DANGEROUS = /^(rm|rmdir\s+\/s|del|erase|format|diskpart|mkfs|shutdown|reboot|poweroff|halt|kill|dd|iex|reg\s+delete|taskkill)(?:[\s]|$)/i;
const BASH_WRITE = /^(mkdir|touch|cp|mv|ren|move|copy|setx|npm\s+(install|i|init|publish|run)|pnpm\s+(install|add|publish)|yarn\s+(add|install)|pip\s+install|git\s+(add|commit|push|checkout|reset|merge|rebase|clean|stash\s+(pop|save|drop)|branch\s+-[dD]|tag)|echo\s+[^|]*[>»])(?:[\s]|$)/i;

const CATEGORY_LABEL: Record<BashCategory, string> = { readonly: '只读查询', write: '写入操作', network: '网络请求', danger: '危险操作' };
const CATEGORY_ICON: Record<BashCategory, string> = { readonly: '📖', write: '✏️', network: '🌐', danger: '☠️' };

function classifyBashSingle(seg: string): BashCategory {
  if (BASH_DANGEROUS.test(seg)) return 'danger';
  if (BASH_WRITE.test(seg)) return 'write';
  if (BASH_NETWORK.test(seg)) return 'network';
  if (BASH_READONLY.test(seg)) return 'readonly';
  return 'danger'; // 未知命令保守确认
}

export function classifyBashCommand(command: string): BashCategory {
  const c = String(command ?? '').trim();
  if (!c) return 'danger';
  const segs = c.split(/\s*(?:&&|\|\||;|\||>>|>|2>)\s*/).map(s => s.trim()).filter(Boolean);
  if (!segs.length) return 'danger';
  const rank: Record<BashCategory, number> = { readonly: 0, write: 1, network: 2, danger: 3 };
  let worst: BashCategory = 'readonly';
  for (const seg of segs) {
    const cat = classifyBashSingle(seg);
    if (rank[cat] > rank[worst]) worst = cat;
  }
  return worst;
}

/** 工具动作分类（审批框徽标用）：bash 按命令分级；其余按只读工具名单 */
export function classifyToolAction(tool: string, args: Record<string, any>): { category: BashCategory; label: string; icon: string } {
  if (tool === 'bash') {
    const c = classifyBashCommand(String(args?.command ?? ''));
    return { category: c, label: CATEGORY_LABEL[c], icon: CATEGORY_ICON[c] };
  }
  if (READONLY_TOOLS.has(tool)) return { category: 'readonly', label: CATEGORY_LABEL.readonly, icon: CATEGORY_ICON.readonly };
  return { category: 'write', label: CATEGORY_LABEL.write, icon: CATEGORY_ICON.write };
}

// ── 会话级批准缓存（Kimi auto_approve_actions 同款）──
// 用户选「Allow this session」的 action 记入缓存，本次进程内同 action 自动放行不再弹
export interface ApprovalCache {
  key(tool: string, args: Record<string, any>): string;
  has(tool: string, args: Record<string, any>): boolean;
  grant(tool: string, args: Record<string, any>): void;
}
export function createApprovalCache(): ApprovalCache {
  const granted = new Set<string>();
  return {
    key: (tool, args) =>
      tool === 'bash'
        ? `bash:${String(args?.command ?? '').trim()}`
        : `${tool}:${String(args?.path ?? JSON.stringify(args ?? {}))}`,
    has: (tool, args) => granted.has(tool === 'bash' ? `bash:${String(args?.command ?? '').trim()}` : `${tool}:${String(args?.path ?? JSON.stringify(args ?? {}))}`),
    grant: (tool, args) => { granted.add(tool === 'bash' ? `bash:${String(args?.command ?? '').trim()}` : `${tool}:${String(args?.path ?? JSON.stringify(args ?? {}))}`); },
  };
}

export function modeVerdict(mode: Mode, tool: string, args: Record<string, any>, toolDanger?: boolean): Verdict {
  // 1. 硬红线：任何模式不可绕过
  const red = hitRedline(tool, args);
  if (red) return 'reject';
  // 2. 敏感路径写保护（fs_write/fs_edit 的 path 参数）
  if (tool === 'fs_write' || tool === 'fs_edit') {
    const path = String(args?.path ?? '');
    if (SENSITIVE_WRITE.test(path)) return 'reject';
  }
  // 3. bash 只读命令分级：只读（pwd/ls/cat/git status…）除 manual 外直接放行
  if (tool === 'bash' && classifyBashCommand(String(args?.command ?? '')) === 'readonly') {
    return mode === 'manual' ? 'confirm' : 'approve';
  }
  const isDanger = toolDanger ?? !READONLY_TOOLS.has(tool);
  // 4. 模式语义（Claude Code 五模式对齐）
  switch (mode) {
    case 'yolo': return 'approve';
    case 'plan': return READONLY_TOOLS.has(tool) ? 'approve' : 'plan'; // 修复：只读研究自由，非只读计划审批
    case 'goal':
    case 'auto':
      // 自动编辑（Claude acceptEdits）：文件编辑自动接受；bash 写/网络/危险按分级确认；只读放行
      if (tool === 'fs_write' || tool === 'fs_edit') return 'approve';
      return isDanger ? 'confirm' : 'approve';
    case 'manual': return isDanger ? 'confirm' : 'approve';
    case 'smart':
    default:
      return isDanger ? 'confirm' : 'approve';
  }
}
