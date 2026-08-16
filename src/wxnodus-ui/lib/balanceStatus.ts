// src/wxnodus-ui/lib/balanceStatus.ts — 状态栏余额/token 段纯函数（可单测）
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 10_000)}万`;
}

export interface BalanceView { balance: string; currency?: string; source?: string }
export function balanceSegmentLabel(v: BalanceView | null): string {
  if (!v) return '💰⚠';
  const c = v.currency === 'USD' ? '$' : v.currency === 'CNY' ? '¥' : '';
  return `💰 ${c}${v.balance}`;
}

export interface UsageView { total: number; range: 'today' | '7d' | '30d' }
export function usageSegmentLabel(v: UsageView): string {
  const label = v.range === 'today' ? '今日' : v.range === '7d' ? '7天' : '30天';
  return `📊 ${fmtCompact(v.total)} ${label}`;
}

export const RANGE_CYCLE = ['today', '7d', '30d'] as const;
export function nextRange(r: string): 'today' | '7d' | '30d' {
  const i = (RANGE_CYCLE as readonly string[]).indexOf(r);
  return RANGE_CYCLE[(i + 1) % 3]!;
}
