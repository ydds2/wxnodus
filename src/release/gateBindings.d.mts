// src/release/gateBindings.d.mts — 类型声明（实现见 gateBindings.mjs）
export interface GateBindings {
  candidateCommit: string;
  artifactId: string;
  artifactSha256: string;
  environmentSnapshot: string;
}
export function parseGateBindings(args: string[]): Partial<GateBindings>;
