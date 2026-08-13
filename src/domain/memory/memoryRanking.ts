// src/domain/memory/memoryRanking.ts — 六分量同池排序：固定权重 + 分量 clamp [0,1]
export interface MemoryRankingComponents { fts: number; vector: number; recency: number; salience: number; sourceTrust: number; scopeWeight: number }
export interface MemoryRankingCandidate extends MemoryRankingComponents { id: string }

const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function rankMemoryCandidates(input: readonly MemoryRankingCandidate[]) {
  return input.map(item => {
    const components = { fts: clamp(item.fts), vector: clamp(item.vector), recency: clamp(item.recency), salience: clamp(item.salience), sourceTrust: clamp(item.sourceTrust), scopeWeight: clamp(item.scopeWeight) };
    const score = 0.30 * components.fts + 0.25 * components.vector + 0.15 * components.recency + 0.10 * components.salience + 0.10 * components.sourceTrust + 0.10 * components.scopeWeight;
    return { id: item.id, score, components };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
