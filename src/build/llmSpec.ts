// src/build/llmSpec.ts — /build LLM 规格化（唯一通道——规则脑已移除，2026-08-18）
// 链路：有密钥时单轮非流式调用模型生成 Spec IR（title/summary/scaffold/acceptance）
//       → validateSpec 校验 → 失败返回 null（调用方直接如实报错，绝不产生假规格）。
// LLM 调用走共享 callModelOnce（src/kernel/llmOnce.ts——与 /compact 同款，融合重复实现）。
// 直连 fetch（与 agent 同模式）——模型 baseURL 是用户配置，可能是本地端点（ollama 等），
// 不走 SSRF 防护（防护面向外部抓取，这里跟随 agent 的直连语义）。

import { SCAFFOLDS, validateSpec } from './spec.js';
import type { Spec, SpecModule } from './spec.js';

const SYSTEM_PROMPT = `你是 WxNodus 的规格分析器。把用户需求编译为规格 JSON，严格只输出以下格式（不要任何其他文本、解释或 markdown 代码围栏）：
{"title":"简短标题（≤30 字）","summary":"需求摘要","scaffold":"ledger|todo|note|anim|generic","acceptance":["验收1","验收2","验收3"],"modules":null 或模块数组}
要求：
- acceptance 恰 3 条，可机器验证，不得含主观词（良好/美观/好用/顺畅/优雅/合理）
- scaffold 按需求本质选择：记账→ledger，待办→todo，笔记知识库→note，动画→anim，其余一律 generic
- summary 概括核心功能，≤200 字
- modules：简单 CRUD 需求填 null；跨域/多子系统/预估产出超 5 个文件的复杂需求，分解为 1~8 个模块的 DAG：
  每模块 {"name":"小写字母数字连字符≤30","deps":["依赖的模块名（无则空数组）"],"desc":"模块职责一句话","files":[{"path":"相对文件路径如 server/index.js","desc":"该文件职责"}]}
  约束：deps 只能引用本数组内其他模块名（不得自依赖、不得成环）；每模块 ≤12 个文件；
  必须有一个模块包含 "server/index.js"（node:http 入口，含 GET /api/health 探活返回 {"ok":true}）；
  模块间用相对 require 互连（如 require('../auth/check.js')）。`;

/**
 * LLM 规格化：单轮非流式生成 Spec IR（共享 callModelOnce——融合 /compact 同款调用）；
 * 任何失败（网络/解析/校验不通过）返回 null——调用方必须如实报错，不得伪造规格。
 */
export async function aiMakeSpec(
  input: string,
  deps: { baseURL: string; model: string; key: string }
): Promise<Spec | null> {
  const { callModelOnce, extractJson } = await import('../kernel/llmOnce.js');
  const r = await callModelOnce({
    baseURL: deps.baseURL,
    model: deps.model,
    key: deps.key,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: input },
    ],
    temperature: 0.2,
    // supremacy ④：结构化输出——Spec 是 JSON 消费方，请求 json_object（端点不支持时
    // extractJson 宽容解析兜底，绝不因 response_format 失败丢规格）
    responseFormat: 'json_object',
  });
  if (!r.ok) return null;
  const parsed = extractJson(r.content);
  if (!parsed) return null;

  // LLM 可能输出非白名单模具——归入 generic（绝不直接透传未知模具）
  const rawScaffold = String(parsed.scaffold ?? '').toLowerCase();
  const scaffold = SCAFFOLDS.includes(rawScaffold as any) ? rawScaffold : 'generic';

  // Spec v2：modules 分解——LLM 输出为数组则原样收录（校验在 validateSpec 统一把关），
  // 非数组（null/缺失/畸形）一律视作「简单需求」走模具模板（向后兼容，不静默降级错误）
  const rawModules = parsed.modules;
  const modules: SpecModule[] | undefined = Array.isArray(rawModules)
    ? rawModules.slice(0, 8).map((m: any) => ({
        name: String(m?.name ?? '').trim().toLowerCase(),
        deps: Array.isArray(m?.deps) ? m.deps.slice(0, 8).map((d: unknown) => String(d).trim().toLowerCase()) : [],
        desc: String(m?.desc ?? '').slice(0, 200).trim(),
        files: Array.isArray(m?.files)
          ? m.files.slice(0, 12).map((f: any) => ({ path: String(f?.path ?? '').trim(), desc: String(f?.desc ?? '').slice(0, 120) }))
          : [],
      }))
    : undefined;

  const spec: Spec = {
    title: String(parsed.title ?? '').slice(0, 30).trim(),
    summary: String(parsed.summary ?? input).slice(0, 500).trim(),
    scaffold,
    acceptance: Array.isArray(parsed.acceptance)
      ? parsed.acceptance.slice(0, 3).map(a => String(a).slice(0, 120))
      : [],
    ...(modules ? { modules } : {}),
  };
  if (!spec.title || !validateSpec(spec).ok) return null;
  return spec;
}
