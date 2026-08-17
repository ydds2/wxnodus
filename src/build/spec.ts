// src/build/spec.ts — L3-1 规格契约（/build 的输入闸门）
// 设计：AI 规格化唯一通道（llmSpec.ts 产出 Spec，本文件只管契约校验）；
//       规则脑（关键词→模具）已移除（2026-08-18），确定性部分仅剩模具白名单与校验。
// A21：分级诊断（error/warning/info）——编译器的语义分析阶段输出
export interface Spec {
  title: string;
  summary: string;
  scaffold: string;
  acceptance: string[];
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
  return { ok: true };
}


