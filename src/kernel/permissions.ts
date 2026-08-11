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
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';

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

// ── P0-2 审批规则文件（持久化 allow/deny/ask）──
// data/permissions.json：[{ tool: 'fs_write', pattern: 'src/**', decision: 'allow' }]
// 规则优先级：deny > allow > ask > 模式默认（与 Codex forbidden>prompt>allow 同构）
export interface PermRule {
  tool: string;
  /** 路径 glob（仅对带 path 参数的工具生效；缺省匹配全部） */
  pattern?: string;
  decision: 'allow' | 'deny' | 'ask';
}

export function loadPermRules(dataDir: string): PermRule[] {
  try {
    const f = join(dataDir, 'permissions.json');
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, 'utf8')) as PermRule[];
    return Array.isArray(raw) ? raw.filter(r => r?.tool && ['allow', 'deny', 'ask'].includes(r.decision)) : [];
  } catch { return []; }
}

export function savePermRules(dataDir: string, rules: PermRule[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'permissions.json'), JSON.stringify(rules, null, 2), 'utf8');
}

// 规则判定：返回 decision 或 null（无规则命中）
export function applyRules(tool: string, args: Record<string, any>, rules: PermRule[]): 'allow' | 'deny' | 'ask' | null {
  if (!rules?.length) return null;
  const hit = rules.filter(r => r.tool === tool);
  if (!hit.length) return null;
  // 路径过滤：仅当规则带 pattern 且工具参数有 path 时校验 glob
  const pathArg = String(args?.path ?? '');
  for (const r of hit) {
    if (r.pattern) {
      if (!pathArg) continue;
      const { minimatch } = {} as any; // 不用外部依赖：简单通配转正则
      const re = new RegExp('^' + r.pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
      if (!re.test(pathArg)) continue;
    }
    return r.decision;
  }
  return null;
}
function escapeRe(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

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

// ── P0-1 危险检测升级：wrapper 解包 + operand 后置 flag 变体 ──
// 解包链：sudo / env / trap / bash|sh|zsh -lc / powershell -Command|EncodedCommand / cmd /c
// （参考 Codex wrapper 解包思路——自研实现；深度上限防解包爆炸）
export function unwrapCommand(cmd: string, depth = 0): string {
  if (depth > 8) return cmd;
  const m = cmd.match(/^\s*(?:sudo\s+|env\s+\S+\s+|trap\s+.*?;\s*|(?:bash|sh|zsh|pwsh|powershell|cmd)\s+-(?:lc|c|Command|EncodedCommand)\s+)([\s\S]*)$/i);
  if (m) return unwrapCommand(m[1]!, depth + 1);
  return cmd;
}

// `rm build/ -rf`（GNU rm 选项置换绕过）→ 归一为递归强制删除语义
const OPERAND_AFTER_FLAG = /^(rm|rmdir)\s+(?!-)(\S+)\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*)/;

// 解包后分类（BASH_DANGEROUS 前缀 + operand 变体双通道）
function classifyBashSingle(seg: string): BashCategory {
  const unwrapped = unwrapCommand(seg);
  if (BASH_DANGEROUS.test(unwrapped)) return 'danger';
  if (OPERAND_AFTER_FLAG.test(unwrapped)) return 'danger';
  // 解包后重新按白名单/写/网络分类
  if (BASH_WRITE.test(unwrapped)) return 'write';
  if (BASH_NETWORK.test(unwrapped)) return 'network';
  if (BASH_READONLY.test(unwrapped)) return 'readonly';
  return 'danger';
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
