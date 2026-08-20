// src/kernel/execPolicy.ts — execpolicy 首词规则（supremacy 1.7 / 缺陷 B-06 落地，2026-08-18）
// 机制参考：codex execpolicy first-token 索引（命令首词快速分发）——实现原创。
// 语义与 permissions.applyRules 完全一致（同一规则文件 data/permissions.json、同一优先级
// priority 降序 + 文件序、同一 pattern 前缀锚定语义）——本模块只做「首词索引」加速 bash 判定：
// 命令首词不在索引桶的规则**不可能**匹配（pattern 锚定 ^），预筛数学上等价、不漏不误。
// 审批持久化：规则本就持久化在 permissions.json（/perm rule add|list|remove 管理，P0-2）
// ——本模块不新增存储面，只加索引层（agent 装配一次、逐工具调用复用）。
import { applyRules, type PermRule } from './permissions.js';

/** 规则 pattern 的首词（首个空白前的 token；无空白=整体）。
 *  空 pattern（匹配全部）与首词含通配/字符类的返回 null——进 catch-all 桶（必须参与任何命令的匹配）。 */
export function firstWordOf(pattern: string): string | null {
  const p = String(pattern ?? '').trim();
  if (!p) return null;
  const m = p.match(/^\S+/);
  const word = m ? m[0] : '';
  if (!word) return null;
  if (/[*?[\]]/.test(word)) return null;
  return word;
}

export interface ExecPolicyIndex {
  /** 首词 → bash 规则候选桶 */
  byWord: Map<string, PermRule[]>;
  /** catch-all：无 pattern / 首词不可索引的规则——任何命令都需参与匹配 */
  catchAll: PermRule[];
}

/** 构建首词索引（bash 规则专用；其余工具规则原样走 applyRules） */
export function buildExecPolicyIndex(rules: PermRule[]): ExecPolicyIndex {
  const byWord = new Map<string, PermRule[]>();
  const catchAll: PermRule[] = [];
  for (const r of rules) {
    if (r.tool !== 'bash') continue;
    const w = firstWordOf(r.pattern ?? '');
    if (w === null) catchAll.push(r);
    else {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w)!.push(r);
    }
  }
  return { byWord, catchAll };
}

/** bash 命令候选规则：首词桶 + catch-all（pattern 锚定保证与全量 applyRules 等价） */
export function pickExecPolicyCandidates(command: string, index: ExecPolicyIndex): PermRule[] {
  const cmd = String(command ?? '').trim();
  if (!cmd) return index.catchAll;
  const w = cmd.split(/\s+/)[0]!;
  return [...(index.byWord.get(w) ?? []), ...index.catchAll];
}

/** bash 专用判定：首词预筛 + applyRules（priority 降序、pattern 前缀锚定、modes 过滤） */
export function applyExecPolicy(
  command: string,
  args: Record<string, any>,
  index: ExecPolicyIndex,
  mode?: string,
): { decision: 'allow' | 'deny' | 'ask'; rule: PermRule } | null {
  const candidates = pickExecPolicyCandidates(command, index);
  if (!candidates.length) return null;
  return applyRules('bash', { ...args, command }, candidates, mode);
}
