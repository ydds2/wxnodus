// src/build/plan.ts — L3-1 计划分解（模块划分 + 依赖拓扑排序 + 里程碑）
// 设计（超复杂项目能力）：规格 → 模块列表（含依赖）→ 拓扑排序 → 里程碑分阶段
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

export function makePlan(input: string, _opts: { key: string | null }): BuildPlan {
  // 规则脑分解：按需求规模划分模块（超复杂项目：api/db/frontend 等）
  const isComplex = input.length > 30 || /系统|平台|管理|多模块|接口/.test(input);
  const modules: ModuleSpec[] = isComplex
    ? [
        { name: 'db', deps: [], desc: '数据层（SQLite 存储与迁移）' },
        { name: 'api', deps: ['db'], desc: '服务端 API（路由/校验/统计）' },
        { name: 'frontend', deps: ['api'], desc: '前端界面（列表/表单/交互）' },
      ]
    : [
        { name: 'app', deps: [], desc: '单模块应用' },
      ];
  const order = topoSort(modules);
  const milestones = isComplex
    ? ['M1 数据层与骨架', 'M2 API 与业务逻辑', 'M3 前端界面与联调', 'M4 验证与交付']
    : ['M1 应用构建', 'M2 验证与交付'];
  return { modules, order, milestones };
}
