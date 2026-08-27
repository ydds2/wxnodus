// src/infrastructure/policy/policyLayers.ts — A3 / P1-4（2026-08-27）：三层策略加载与合并
// 定位（企业可治理）：全局（管理员部署，%ProgramData%——只读）> 用户（dataDir/permissions.json）
// > 项目（工作区 .wxnodus/policy.json）。
// 合并语义（红线精神）：
//   ① deny 不可被更不可信层放宽——信任序 global > user > project：deny 按层加权
//     （global +2000 / user +1000 / project +0）压过任何下层 allow（applyRules priority 主序）；
//   ② allow/ask 同 key（tool+pattern）具体层优先：项目 > 用户 > 全局（同层内
//     具体度/decision 平局裁决由 applyRules 保证——B-06 语义不破坏）；
//   ③ 全局文件损坏/非法 → 该层规则丢弃 + 诊断（fail-closed 记录，绝不静默吞错）；
//   ④ 硬红线（代码侧 HARD_REDLINES/SENSITIVE_WRITE）不在此机制内，任何层不可触及。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 策略规则（与 kernel/permissions.PermRule 同构——infrastructure 不 import kernel，避免层环） */
export interface PolicyRule {
  tool: string;
  pattern?: string;
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  priority?: number;
  modes?: string[];
  denyMessage?: string;
}

export type PolicyLayerName = 'global' | 'user' | 'project';

export interface PolicyLayer {
  name: PolicyLayerName;
  path: string;
  rules: PolicyRule[];
  /** 加载失败原因（文件损坏/结构非法）——层规则丢弃时的诊断依据 */
  loadError?: string;
  /** 文件不存在（诚实区分「未部署」与「部署了但损坏」） */
  missing: boolean;
}

export interface PolicyLayerInput {
  dataDir: string;
  workspaceRoot: string;
  /** 全局策略路径（默认 %ProgramData%\wxnodus\policy.json；测试经 env 覆盖） */
  globalPath?: string;
}

export function resolvePolicyPaths(input: PolicyLayerInput, env: NodeJS.ProcessEnv = process.env): Record<PolicyLayerName, string> {
  const programData = env.WXNODUS_GLOBAL_POLICY ?? (env.ProgramData ? join(env.ProgramData, 'wxnodus', 'policy.json') : '');
  return {
    global: input.globalPath ?? programData,
    user: join(input.dataDir, 'permissions.json'),
    project: join(input.workspaceRoot, '.wxnodus', 'policy.json'),
  };
}

const VALID_DECISIONS = new Set(['allow', 'deny', 'ask']);

/** 单层加载：损坏/非法 → loadError + 空规则（绝不静默吞错；绝不在坏文件上猜测规则） */
export function loadPolicyLayer(name: PolicyLayerName, path: string): PolicyLayer {
  if (!path || !existsSync(path)) return { name, path, rules: [], missing: true };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return { name, path, rules: [], missing: false, loadError: '策略文件须为规则数组（JSON array）' };
    const rules: PolicyRule[] = [];
    let skipped = 0;
    for (const item of raw) {
      const r = item as Partial<PolicyRule> | null;
      if (r && typeof r.tool === 'string' && VALID_DECISIONS.has(String(r.decision))) {
        rules.push({
          tool: r.tool,
          pattern: typeof r.pattern === 'string' ? r.pattern : undefined,
          decision: r.decision as PolicyRule['decision'],
          reason: typeof r.reason === 'string' ? r.reason : undefined,
          priority: typeof r.priority === 'number' ? r.priority : undefined,
          modes: Array.isArray(r.modes) ? r.modes.filter(m => typeof m === 'string') : undefined,
          denyMessage: typeof r.denyMessage === 'string' ? r.denyMessage : undefined,
        });
      } else skipped++;
    }
    return { name, path, rules, missing: false, loadError: skipped > 0 ? `${skipped} 条非法规则已跳过（缺 tool/decision 或 decision 非法）` : undefined };
  } catch (e) {
    return { name, path, rules: [], missing: false, loadError: `策略文件无法解析（${String((e as Error)?.message ?? e).slice(0, 100)}）——该层规则已丢弃` };
  }
}

/** 规则同 key（合并/覆盖的单位）：tool + pattern（无 pattern 与有 pattern 是不同 key） */
const ruleKey = (r: PolicyRule): string => `${r.tool}\u0000${r.pattern ?? ''}`;

export interface MergedPolicy {
  rules: PolicyRule[];
  layers: PolicyLayer[];
  diagnostics: string[];
}

/** 三层加载 + 合并（语义见文件头）。返回 merged 规则（可直接作为 applyRules 输入） */
export function loadMergedPolicyRules(input: PolicyLayerInput, env: NodeJS.ProcessEnv = process.env): MergedPolicy {
  const paths = resolvePolicyPaths(input, env);
  const layers: PolicyLayer[] = [
    loadPolicyLayer('global', paths.global),
    loadPolicyLayer('user', paths.user),
    loadPolicyLayer('project', paths.project),
  ];
  const diagnostics: string[] = [];
  for (const layer of layers) {
    if (layer.loadError) diagnostics.push(`${layer.name} 层（${layer.path}）：${layer.loadError}`);
  }
  // ① deny 全集（所有层相加）——信任序加权保证「更可信层的 deny 不可被下层放宽」：
  //    global deny +2000 / user deny +1000 / project deny +0（applyRules 主序 priority 降序，
  //    跨层 allow 优先级再高也压不过更可信层的 deny；同层内部仍走 具体度→decision 平局裁决）。
  const DENY_BOOST: Record<PolicyLayerName, number> = { global: 2000, user: 1000, project: 0 };
  const denies: PolicyRule[] = layers.flatMap(l => l.rules
    .filter(r => r.decision === 'deny')
    .map(r => ({ ...r, priority: (r.priority ?? 0) + DENY_BOOST[l.name] })));
  // ② allow/ask 按具体层优先（项目 > 用户 > 全局），同 key 保留最具体层
  const byKey = new Map<string, PolicyRule>();
  for (const layer of layers) {
    for (const r of layer.rules) {
      if (r.decision === 'deny') continue;
      const key = ruleKey(r);
      const existing = byKey.get(key);
      if (!existing) { byKey.set(key, r); continue; }
      // 已有规则来自更具体层则不动；同层后写覆盖（文件顺序语义）
      const layerRank = { project: 2, user: 1, global: 0 } as const;
      const existingLayer = layers.find(l => l.rules.includes(existing))!;
      if (layerRank[layer.name] >= layerRank[existingLayer.name]) byKey.set(key, r);
    }
  }
  const rules = [...byKey.values(), ...denies];
  return { rules, layers, diagnostics };
}
