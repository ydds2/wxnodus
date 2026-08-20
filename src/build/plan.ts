// src/build/plan.ts — L3-1 计划分解（模块划分 + 依赖拓扑排序 + 里程碑）
// 规则脑分解（makePlan）已移除（2026-08-18）：计划由调用方固定构造（单模块 app），
// 本文件仅保留计划类型与拓扑排序。
export interface ModuleSpec { name: string; deps: string[]; desc: string }

export interface BuildPlan {
  modules: ModuleSpec[];
  order: string[];
  milestones: string[];
}

// 拓扑排序（Kahn）：依赖在前；循环依赖抛错
export function topoSort(mods: Array<{ name: string; deps: string[] }>): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const m of mods) {
    indeg.set(m.name, m.deps.length);
    for (const d of m.deps) {
      if (!adj.has(d)) adj.set(d, []);
      adj.get(d)!.push(m.name);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of adj.get(n) ?? []) {
      const v = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, v);
      if (v === 0) queue.push(next);
    }
  }
  if (order.length !== mods.length) throw new Error('循环依赖检测失败：模块无法拓扑排序');
  return order;
}
