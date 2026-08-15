// src/release/gateBindings.ts — W8-19：wave3 门绑定参数解析（kebab flag → camelCase 绑定）
// 实盘缺陷：run-wave3-gates 曾以 kebab-case 键存绑定（binding['candidate-commit']）、camelCase 读
// （binding.candidateCommit）——全 undefined → C-W3 drill 收到空候选/工件哈希 → 绑定漂移/缺失的假 blocked。
// 解析统一转 camelCase，任何缺失如实 undefined（绝不编默认值——绑定必须显式供给）。
export interface GateBindings {
  candidateCommit: string;
  artifactId: string;
  artifactSha256: string;
  environmentSnapshot: string;
}

const FLAG_KEYS: Array<[string, keyof GateBindings]> = [
  ['--candidate-commit', 'candidateCommit'],
  ['--artifact-id', 'artifactId'],
  ['--artifact-sha256', 'artifactSha256'],
  ['--environment-snapshot', 'environmentSnapshot'],
];

export function parseGateBindings(args: string[]): Partial<GateBindings> {
  const binding: Partial<GateBindings> = {};
  for (const [flag, key] of FLAG_KEYS) {
    const index = args.indexOf(flag);
    if (index >= 0) binding[key] = args[index + 1];
  }
  return binding;
}
