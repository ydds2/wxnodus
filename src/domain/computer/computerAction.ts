// src/domain/computer/computerAction.ts — 计算机动作契约：高影响 kind 集合 + 动作上下文（runId/effectId/correlationId 贯穿全管线）
export interface ComputerAction {
  kind: string;
  target: { type: string; id: string; display?: string };
  effect: { summary: string; parameters: Record<string, string | number | boolean | null> };
  reversibility?: { reversible: boolean; method: string | null; deadline: string | null };
  verification?: { verifierId: string; description: string };
}

export const HIGH_IMPACT_KINDS = ['external-send', 'delete', 'payment', 'publish', 'system-config'] as const;
export type HighImpactKind = (typeof HIGH_IMPACT_KINDS)[number];

export const isHighImpactKind = (kind: string): kind is HighImpactKind =>
  (HIGH_IMPACT_KINDS as readonly string[]).includes(kind);

export interface ComputerActionContext {
  actorId: string;
  sessionId: string;
  runId: string;
  effectId: string;
  correlationId: string;
}
