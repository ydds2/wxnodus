// src/release/releaseScope.ts — W6-05：发布范围（Windows-only 产品定位——用户决策）
// windows：只需在 Windows 上跑——跨平台 Gate I 退出必选范围（机制保留，all 范围照常要求）。
// 决策落码：缺省即 windows（不传 scope 与显式 windows 等价；绝不静默把范围当全平台）。
export type ReleaseScope = 'windows' | 'all';

export function resolveReleaseScope(value: string | undefined): ReleaseScope {
  return value === 'all' ? 'all' : 'windows';
}

export function requiredReleaseGates(scope: ReleaseScope): string[] {
  return scope === 'all'
    ? ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']
    : ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
}
