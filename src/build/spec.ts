// src/build/spec.ts — L3-1 规格契约（概念编译器的输入闸门）
// 设计：规则脑关键词→模具（零 key 可用）；LLM 增强开放域（有 key 时）；契约校验（3 条验收/禁主观词）
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

const SCAFFOLDS = ['ledger', 'todo', 'note', 'anim', 'generic'] as const;

// 规则脑模具关键词表
const RULES: Array<{ re: RegExp; scaffold: string }> = [
  { re: /记账|账本|财务|收支|ledger|bookkeep/i, scaffold: 'ledger' },
  { re: /待办|任务清单|todo|task list/i, scaffold: 'todo' },
  { re: /笔记|知识库|note|wiki/i, scaffold: 'note' },
  { re: /动画|分镜|anim/i, scaffold: 'anim' },
  { re: /系统|网站|应用|工具|页面|管理/i, scaffold: 'generic' },
];

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

export function makeSpec(input: string, opts: { key: string | null }): Spec {
  // 规则脑优先
  for (const r of RULES) {
    if (r.re.test(input)) {
      const spec: Spec = {
        title: input.slice(0, 14),
        summary: input,
        scaffold: r.scaffold,
        acceptance: [
          '能完成核心数据的新增与展示',
          '数据本地持久化，重启不丢失',
          '提供清晰的用户操作入口',
        ],
      };
      return validateSpec(spec).ok ? spec : { ...spec, scaffold: 'generic' };
    }
  }
  // 开放域：有 key 时 LLM 补充（agent 层接入）；无 key 诚实拒答
  return { title: '', summary: '', scaffold: 'unknown', acceptance: [] };
}

