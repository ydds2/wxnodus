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
import type { NormativeRedlineCategory, PolicyMatcher } from '../policy/schema.js';

export type Mode = 'smart' | 'auto' | 'manual' | 'plan' | 'yolo' | 'goal';
export type Verdict = 'approve' | 'reject' | 'confirm' | 'plan';

export interface Redline { pattern: RegExp; desc: string }

/** 规范性规则描述符：稳定 id/version/category——Policy Manifest 与运行时 HARD_REDLINES 的单一事实源 */
export interface PolicyRuleSource {
  id: string;
  version: number;
  kind: 'hard_redline' | 'sensitive_write' | 'command_redline';
  category: NormativeRedlineCategory;
  descriptionKey: string;
  source: string;
  overrideable: false;
  requiresUserPresence: boolean;
  matcher: PolicyMatcher;
}

const POLICY_RULE_SOURCES: readonly PolicyRuleSource[] = [
  // ── root_home_recursive_destruction ──
  { id: 'redline.rm-rf-root-home', version: 1, kind: 'hard_redline', category: 'root_home_recursive_destruction', descriptionKey: 'policy.redline.rm_rf_root_home', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: 'rm\\s+-rf\\s+\\/|rm\\s+-rf\\s+[a-zA-Z]:[\\\\/]|rm\\s+-rf\\s+~(?=[\\\\/]|\\s|$)|rm\\s+-rf\\s+~\\/*', flags: 'i' } },
  { id: 'redline.rm-rf-home-env', version: 1, kind: 'hard_redline', category: 'root_home_recursive_destruction', descriptionKey: 'policy.redline.rm_rf_home_env', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: 'rm\\s+-rf\\s+(?:\\$HOME|%USERPROFILE%|\\/home\\/|\\/root)(?:\\s|$)', flags: 'i' } },
  { id: 'redline.del-recursive-system-drive', version: 1, kind: 'hard_redline', category: 'root_home_recursive_destruction', descriptionKey: 'policy.redline.del_recursive_system_drive', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: 'del\\s+\\/f\\s+\\/s\\s+[a-zA-Z]:[\\\\/]|Remove-Item\\s+-Recurse\\s+-Force\\s+[a-zA-Z]:[\\\\/]', flags: 'i' } },
  // ── disk_format_partition_raw_write ──
  { id: 'redline.format-drive', version: 1, kind: 'hard_redline', category: 'disk_format_partition_raw_write', descriptionKey: 'policy.redline.format_drive', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\bformat\\s+[a-zA-Z]:', flags: 'i' } },
  { id: 'redline.diskpart', version: 1, kind: 'hard_redline', category: 'disk_format_partition_raw_write', descriptionKey: 'policy.redline.diskpart', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\bdiskpart\\b', flags: 'i' } },
  { id: 'redline.mkfs', version: 1, kind: 'hard_redline', category: 'disk_format_partition_raw_write', descriptionKey: 'policy.redline.mkfs', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\bmkfs(?:\\s|$)', flags: 'i' } },
  { id: 'redline.dd-raw-device', version: 1, kind: 'hard_redline', category: 'disk_format_partition_raw_write', descriptionKey: 'policy.redline.dd_raw_device', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\bdd\\s+.*\\bof=\\/dev\\/(?:sd|nvme|hd)', flags: 'i' } },
  // ── shutdown_restart_fork_bomb ──
  { id: 'redline.shutdown-reboot', version: 1, kind: 'hard_redline', category: 'shutdown_restart_fork_bomb', descriptionKey: 'policy.redline.shutdown_reboot', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\b(shutdown|reboot|poweroff|halt|init\\s+0|telinit\\s+0|systemctl\\s+(poweroff|reboot))\\b', flags: 'i' } },
  { id: 'redline.kill-1-fork-bomb', version: 1, kind: 'hard_redline', category: 'shutdown_restart_fork_bomb', descriptionKey: 'policy.redline.kill_1_fork_bomb', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\bkill\\s+-9?\\s+-1\\b|:\\(\\)\\s*\\{\\s*:\\|:\\s*&\\s*\\}\\s*;', flags: 'i' } },
  // ── system_registry_destruction ──
  { id: 'redline.reg-delete-hklm', version: 1, kind: 'hard_redline', category: 'system_registry_destruction', descriptionKey: 'policy.redline.reg_delete_hklm', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\breg\\s+delete\\s+HKLM', flags: 'i' } },
  // ── interpreter_pipe_injection ──
  { id: 'redline.iex-powershell', version: 1, kind: 'hard_redline', category: 'interpreter_pipe_injection', descriptionKey: 'policy.redline.iex_powershell', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\biex\\b|Invoke-Expression|Format-Volume', flags: 'i' } },
  { id: 'redline.pipe-to-shell', version: 1, kind: 'hard_redline', category: 'interpreter_pipe_injection', descriptionKey: 'policy.redline.pipe_to_shell', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '\\|\\s*(sh|bash|pwsh|powershell)\\b', flags: 'i' } },
  // ── remote_history_force_push ──
  { id: 'redline.git-push-force', version: 1, kind: 'hard_redline', category: 'remote_history_force_push', descriptionKey: 'policy.redline.git_push_force', source: 'permissions.ts#HARD_REDLINES', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: 'git\\s+push\\s+--force(?:\\s|$)', flags: 'i' } },
  // ── credential_secret_persistence_leak ──
  { id: 'redline.sensitive-write', version: 1, kind: 'sensitive_write', category: 'credential_secret_persistence_leak', descriptionKey: 'policy.redline.sensitive_write', source: 'permissions.ts#SENSITIVE_WRITE', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '(^|[\\\\/])(\\.bashrc|\\.zshrc|\\.profile|\\.bash_profile|\\.ssh[\\\\/].*|\\.env|\\.env\\.local|id_rsa|id_ed25519|authorized_keys|known_hosts|\\.git[\\\\/]config|\\.npmrc|\\.pypirc|settings\\.json(?:\\.tmp)?|permissions\\.json(?:\\.tmp)?)(\\s|$)', flags: 'i' } },
  { id: 'redline.credential-file-write', version: 1, kind: 'sensitive_write', category: 'credential_secret_persistence_leak', descriptionKey: 'policy.redline.credential_file_write', source: 'permissions.ts#CREDENTIAL_WRITE', overrideable: false, requiresUserPresence: false, matcher: { type: 'regex', value: '(^|[\\\\/])(.*\\.(pem|key|p12|pfx|jks)|credentials(\\.[a-z]+)?|\\.aws[\\\\/]credentials|\\.kube[\\\\/]config)(\\s|$)', flags: 'i' } },
  // ── unmediated_privilege_key_security_mode_change ──
  ...(['/perm', '/perm rule', '/yolo', '/afk', '/key set', '/key off', '/self-evolve', '/security', '/security sudo on', '/security secret on', '/sandbox L0', '/sandbox L1', '/sandbox L2', '/sandbox L3', '/plan on', '/plan off'] as const).map(command => ({
    id: `redline.command.${command.replace(/[^a-z0-9]+/gi, '-')}`,
    version: 1,
    kind: 'command_redline' as const,
    category: 'unmediated_privilege_key_security_mode_change' as const,
    descriptionKey: 'policy.redline.unmediated_privilege_key_security_mode_change',
    source: 'kernel/commandLevels.ts#COMMAND_LEVELS',
    overrideable: false as const,
    requiresUserPresence: true,
    matcher: { type: 'command' as const, value: command },
  })),
];

const matcherToRegex = (matcher: PolicyMatcher): RegExp =>
  matcher.type === 'regex' ? new RegExp(matcher.value, matcher.flags) : new RegExp('(?:)');

// 硬红线清单（任何模式不可绕过——安全底线）：由规范性规则目录派生（单一事实源，杜绝双写漂移）
export const HARD_REDLINES: Redline[] = POLICY_RULE_SOURCES
  .filter(rule => rule.kind === 'hard_redline')
  .map(rule => ({ pattern: matcherToRegex(rule.matcher), desc: rule.descriptionKey }));

/** 规范性规则目录（Policy Manifest 生成输入） */
export function policyRuleSources(): readonly PolicyRuleSource[] {
  return POLICY_RULE_SOURCES;
}

function hitRedline(tool: string, args: Record<string, any>): Redline | null {
  const text = [tool, ...Object.values(args ?? {})].map(String).join(' ');
  for (const r of HARD_REDLINES) if (r.pattern.test(text)) return r;
  return null;
}

// 敏感路径写保护（修复 F13）：fs_write/fs_edit 写入凭据/配置/密钥文件直接拒绝
// 单一事实源：由规范性规则目录中 kind==='sensitive_write' 派生（含凭据文件扩展）
const SENSITIVE_WRITE_MATCHERS: RegExp[] = POLICY_RULE_SOURCES
  .filter(rule => rule.kind === 'sensitive_write')
  .map(rule => matcherToRegex(rule.matcher));

// ── P0-2 审批规则文件（持久化 allow/deny/ask）──
// data/permissions.json：[{ tool: 'fs_write', pattern: 'src/**', decision: 'allow' }]
// 规则优先级：priority 大者先（缺省 0）→ 同 priority 按文件顺序；deny > allow > ask
// （与 Codex forbidden>prompt>allow、Gemini policy priority 同构）
export interface PermRule {
  tool: string;
  /** 路径 glob（仅对带 path 参数的工具生效；bash 工具匹配命令前缀；缺省匹配全部） */
  pattern?: string;
  decision: 'allow' | 'deny' | 'ask';
  /** 人工可读理由（Codex exec policy 同款——规则为何存在，审计可追溯） */
  reason?: string;
  /** 深度（Gemini policy priority 对齐）：规则优先级，大者先匹配（缺省 0） */
  priority?: number;
  /** 深度（Gemini policy modes 对齐）：限定生效的权限模式（缺省全部模式生效） */
  modes?: string[];
  /** 深度（Gemini denyMessage 对齐）：deny 时定制拒绝提示（如「git push 请手动执行」） */
  denyMessage?: string;
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

/** 规则判定：返回 decision 或 null（无规则命中）。mode 传入时按 modes 过滤（Gemini policy modes 对齐） */
export function applyRules(tool: string, args: Record<string, any>, rules: PermRule[], mode?: string): { decision: 'allow' | 'deny' | 'ask'; rule: PermRule } | null {
  if (!rules?.length) return null;
  // priority 降序（同优先按文件序稳定）；modes 过滤
  const hit = rules
    .filter(r => r.tool === tool && (!r.modes?.length || (mode && r.modes.includes(mode))))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  if (!hit.length) return null;
  // 路径/命令过滤：pattern 对 bash 匹配命令前缀（精确授权「git push 特定分支」），
  // 其余工具匹配 path 参数 glob（缺省匹配全部）
  const pathArg = String(args?.path ?? '');
  const cmdArg = tool === 'bash' ? String(args?.command ?? '') : '';
  for (const r of hit) {
    if (r.pattern) {
      if (tool === 'bash') {
        if (!cmdArg) continue;
        const re = new RegExp('^' + r.pattern.split('*').map(escapeRe).join('.*'));
        if (!re.test(cmdArg)) continue;
      } else {
        if (!pathArg) continue;
        const re = new RegExp('^' + r.pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
        if (!re.test(pathArg)) continue;
      }
    }
    return { decision: r.decision, rule: r };
  }
  return null;
}
function escapeRe(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

// 只读工具名单（开放兼容：装配时由工具表自动推导 setReadonlyTools——
// danger!==true 的内置工具即只读；不再手工双写，杜绝名单漂移）
// 注意：memory_write/http_get 有副作用/外联（danger 语义已标注），推导时自动排除
let READONLY_TOOLS = new Set<string>(['fs_read', 'ls', 'grep', 'skill_load', 'repo_map']);

/** 由工具表推导只读名单：danger 未标 true 的即为只读（与 modeVerdict 的 toolDanger 语义一致） */
export function deriveReadonlyTools(tools: Record<string, { danger?: boolean }>): string[] {
  return Object.entries(tools)
    .filter(([, t]) => t.danger !== true)
    .map(([name]) => name);
}

/** 装配时注入推导结果（cli/index.ts：coreTools() + 内置工具集） */
export function setReadonlyTools(names: Iterable<string>): void {
  READONLY_TOOLS = new Set(names);
}

export function isReadonlyTool(tool: string): boolean {
  return READONLY_TOOLS.has(tool);
}

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
  // 2. 敏感路径写保护（fs_write/fs_edit 的 path 参数——凭据/密钥/配置文件一律拒绝）
  if (tool === 'fs_write' || tool === 'fs_edit') {
    const path = String(args?.path ?? '');
    if (SENSITIVE_WRITE_MATCHERS.some(re => re.test(path))) return 'reject';
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
    case 'manual': return 'confirm'; // 全量确认：所有动作（含只读查询）都先征求用户同意
    case 'smart':
    default:
      return isDanger ? 'confirm' : 'approve';
  }
}
