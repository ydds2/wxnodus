// src/domain/autonomy/budgetDimensions.ts — 全维预算（15 维）
export const ALL_BUDGET_DIMENSIONS = ['token','cost','wallclock','turn','tool','retry','depth','fanout',
  'concurrent-agent','network','external-writes','browser-desktop','screenshot','files','bytes'] as const;
export type BudgetDimension = typeof ALL_BUDGET_DIMENSIONS[number];
