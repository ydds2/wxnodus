// src/application/tools/defaultToolPolicy.ts — W1-08：CLI 默认策略文档（诚实 fail-closed 默认）
// allow：memory.read / filesystem.read（工作区隔离读）；require_approval：filesystem.write /
// network.request / process.spawn / memory.write / config.write / extension.manage / ui.external
// （高危副作用走人工审批桥）；其余 effect kind 无规则 → deny。
// 8 条硬红线在 PDP 上层合规层强制（审批/存证/审计），不经 effect kind 表达——hardRedlineKinds 留空。
import type { PolicyDocument } from '../../domain/security/pdp.js';

export const DEFAULT_TOOL_POLICY: PolicyDocument = {
  version: 1,
  hardRedlineKinds: [],
  rules: [
    { effectKind: 'memory.read', action: 'allow' },
    { effectKind: 'filesystem.read', action: 'allow' },
    { effectKind: 'filesystem.write', action: 'require_approval' },
    { effectKind: 'network.request', action: 'require_approval' },
    { effectKind: 'process.spawn', action: 'require_approval' },
    { effectKind: 'memory.write', action: 'require_approval' },
    { effectKind: 'config.write', action: 'require_approval' },
    { effectKind: 'extension.manage', action: 'require_approval' },
    { effectKind: 'ui.external', action: 'require_approval' },
  ],
};

export const DEFAULT_TOOL_BUDGET_LIMITS: Record<string, number> = {
  externalWrites: 200,
  networkRequests: 100,
  processSpawns: 50,
};
