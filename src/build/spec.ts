// src/build/spec.ts — L3-1 规格契约（/build 的输入闸门）
// 设计：AI 规格化唯一通道（llmSpec.ts 产出 Spec，本文件只管契约校验）；
//       规则脑（关键词→模具）已移除（2026-08-18），确定性部分仅剩模具白名单与校验。
// A21：分级诊断（error/warning/info）——编译器的语义分析阶段输出
// 2026-08-19 Spec v2（复杂需求构造能力）：可选 modules 分解——AI 把跨域/多子系统需求
// 拆为模块 DAG（每模块文件清单）；缺失 = 简单需求走模具模板（向后兼容）。
import { topoSort } from './plan.js';
export interface SpecModule {
  /** 模块名：小写字母/数字/连字符（≤30）——同时是生成目录名（路径安全白名单） */
  name: string;
  /** 依赖模块名（必须指向本分解内其他模块；拓扑排序保证依赖先生成） */
  deps: string[];
  /** 模块职责（生成提示词上下文） */
  desc: string;
  /** 该模块产出文件清单（相对项目根的相对路径 + 职责说明） */
  files: Array<{ path: string; desc: string }>;
}

export interface Spec {
  title: string;
  summary: string;
  scaffold: string;
  acceptance: string[];
  /** Spec v2：复杂需求模块分解（≤8 模块 × ≤12 文件）；缺失 = 简单需求（模具模板路径） */
  modules?: SpecModule[];
}

export interface SpecDiagnostic {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

/** 模具集合（llmSpec.ts 校验 LLM 输出合法性复用） */
export const SCAFFOLDS = ['ledger', 'todo', 'note', 'anim', 'generic'] as const;

const SUBJECTIVE = /良好|合理|美观|优雅|好用|顺畅/;

/** A21：分级诊断（error=阻断编译 / warning=可编译但提示 / info=信息） */
export function diagnoseSpec(s: Spec): SpecDiagnostic[] {
  const out: SpecDiagnostic[] = [];
  if (!s.title) out.push({ level: 'error', code: 'spec.title.missing', message: '标题必填' });
  if (!s.summary) out.push({ level: 'error', code: 'spec.summary.missing', message: '摘要必填' });
  if (!SCAFFOLDS.includes(s.scaffold as any)) {
    out.push({ level: 'error', code: 'spec.scaffold.invalid', message: `模具必须∈${SCAFFOLDS.join('/')}` });
  }
  if (s.acceptance.length !== 3) {
    out.push({
      level: s.acceptance.length === 0 ? 'error' : 'warning',
      code: 'spec.acceptance.count',
      message: `验收 ${s.acceptance.length}/3 条（建议恰 3 条，可验收可机器验证）`,
    });
  }
  for (const a of s.acceptance) {
    if (SUBJECTIVE.test(a)) out.push({ level: 'error', code: 'spec.acceptance.subjective', message: `验收含主观词：${a}` });
  }
  if (s.title && s.title.length > 30) out.push({ level: 'warning', code: 'spec.title.long', message: '标题过长（>30 字符），建议精简' });
  if (s.summary && s.summary.length > 500) out.push({ level: 'warning', code: 'spec.summary.long', message: '摘要过长（>500 字符），建议收敛需求范围' });
  if (s.scaffold && SCAFFOLDS.includes(s.scaffold as any)) {
    out.push({ level: 'info', code: 'spec.scaffold.hit', message: `模具命中：${s.scaffold}` });
  }
  return out;
}

export function validateSpec(s: Spec): { ok: boolean; reason?: string } {
  const errors = diagnoseSpec(s).filter(d => d.level === 'error');
  if (errors.length) return { ok: false, reason: errors.map(e => e.message).join('；') };
  // Spec v2：modules 结构校验（存在即校验——不静默降级）
  if (s.modules) {
    const names = new Set<string>();
    const MOD_NAME = /^[a-z][a-z0-9-]{0,29}$/;
    const FILE_PATH = /^[a-z0-9][a-z0-9-_]*(\/[a-z0-9][a-z0-9-_]*)*\.[a-z0-9]{1,10}$/;
    if (s.modules.length === 0) return { ok: false, reason: 'modules 为空数组——要么给出有效分解，要么省略该字段' };
    if (s.modules.length > 8) return { ok: false, reason: `模块数 ${s.modules.length} 超上限 8` };
    for (const m of s.modules) {
      if (!MOD_NAME.test(m.name)) return { ok: false, reason: `模块名非法：${m.name}（小写字母/数字/-，≤30）` };
      if (names.has(m.name)) return { ok: false, reason: `模块名重复：${m.name}` };
      names.add(m.name);
      if (!m.desc?.trim()) return { ok: false, reason: `模块 ${m.name} 缺职责描述` };
      if (!Array.isArray(m.files) || !m.files.length) return { ok: false, reason: `模块 ${m.name} 缺文件清单` };
      if (m.files.length > 12) return { ok: false, reason: `模块 ${m.name} 文件数 ${m.files.length} 超上限 12` };
      for (const f of m.files) {
        if (!FILE_PATH.test(f.path)) return { ok: false, reason: `文件路径非法：${f.path}（相对路径，小写字母/数字/-/_，禁止 .. 与绝对路径）` };
      }
      for (const d of m.deps) {
        if (d === m.name) return { ok: false, reason: `模块 ${m.name} 自依赖` };
        if (!names.has(d)) return { ok: false, reason: `模块 ${m.name} 依赖未知模块：${d}` };
      }
    }
    // 依赖环检测（topoSort 抛错 → 规格拒绝）
    try {
      topoSort(s.modules.map(m => ({ name: m.name, deps: m.deps })));
    } catch {
      return { ok: false, reason: '模块依赖存在循环' };
    }
  }
  return { ok: true };
}


