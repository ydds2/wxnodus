// src/build/llmSpec.ts — /build LLM 开放域规格化（P0-1）
// 链路：规则脑未命中（scaffold=unknown）且有密钥时，单轮非流式调用模型
//       生成 Spec IR（title/summary/scaffold/acceptance）→ validateSpec 校验 →
//       失败返回 null（调用方降级规则脑并明示，绝不产生假规格）。
// 直连 fetch（与 agent 同模式）——模型 baseURL 是用户配置，可能是本地端点（ollama 等），
// 不走 SSRF 防护（防护面向外部抓取，这里跟随 agent 的直连语义）。

import { buildChatRequest } from '../kernel/providers.js';
import { SCAFFOLDS, validateSpec } from './spec.js';
import type { Spec } from './spec.js';

const SYSTEM_PROMPT = `你是概念编译器 WxNodus 的规格分析器。把用户需求编译为规格 JSON，严格只输出以下格式（不要任何其他文本、解释或 markdown 代码围栏）：
{"title":"简短标题（≤30 字）","summary":"需求摘要","scaffold":"ledger|todo|note|anim|generic","acceptance":["验收1","验收2","验收3"]}
要求：
- acceptance 恰 3 条，可机器验证，不得含主观词（良好/美观/好用/顺畅/优雅/合理）
- scaffold 按需求本质选择：记账→ledger，待办→todo，笔记知识库→note，动画→anim，其余一律 generic
- summary 概括核心功能，≤200 字`;

/** 从模型响应中提取 JSON 对象（容错：剥离 markdown 代码围栏与前后噪声） */
function extractJson(s: string): Record<string, unknown> | null {
  const cleaned = String(s ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * LLM 规格化：单轮非流式生成 Spec IR；任何失败（网络/解析/校验不通过）返回 null——
 * 调用方必须降级规则脑并如实提示，不得伪造规格。
 */
export async function aiMakeSpec(
  input: string,
  deps: { baseURL: string; model: string; key: string }
): Promise<Spec | null> {
  const httpReq = buildChatRequest({
    baseURL: deps.baseURL,
    model: deps.model,
    key: deps.key,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: input },
    ],
    stream: false,
    temperature: 0.2,
  });

  let resp: Response;
  try {
    resp = await fetch(httpReq.url, {
      method: 'POST',
      headers: httpReq.headers,
      body: httpReq.body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let j: any;
  try {
    j = await resp.json();
  } catch {
    return null;
  }
  const content: string = j?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(content);
  if (!parsed) return null;

  // LLM 可能输出非白名单模具——归入 generic（绝不直接透传未知模具）
  const rawScaffold = String(parsed.scaffold ?? '').toLowerCase();
  const scaffold = SCAFFOLDS.includes(rawScaffold as any) ? rawScaffold : 'generic';

  const spec: Spec = {
    title: String(parsed.title ?? '').slice(0, 30).trim(),
    summary: String(parsed.summary ?? input).slice(0, 500).trim(),
    scaffold,
    acceptance: Array.isArray(parsed.acceptance)
      ? parsed.acceptance.slice(0, 3).map(a => String(a).slice(0, 120))
      : [],
  };
  if (!spec.title || !validateSpec(spec).ok) return null;
  return spec;
}
