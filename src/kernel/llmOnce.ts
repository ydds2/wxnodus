// src/kernel/llmOnce.ts — 共享非流式单轮 LLM 调用（融合 /compact、llmSpec 的重复实现）
// 此前 /compact summarize 与 llmSpec.aiMakeSpec 各有一份「buildChatRequest → fetch →
// json → content」+ 错误处理 + JSON 抽取——融合为单一事实源，错误映射统一走 mapHttpError。
import { buildChatRequest, mapHttpError, type ChatMessage } from './providers.js';

export interface LlmOnceOpts {
  baseURL: string;
  model: string;
  key: string;
  messages: ChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  /** supremacy ④：结构化输出（response_format json_object——llmSpec 等 JSON 消费方） */
  responseFormat?: 'json_object';
}

export type LlmOnceResult = { ok: true; content: string } | { ok: false; error: string };

/** 单轮非流式调用（模型直连 fetch，与 agent 流式同语义；失败返回错误不抛出） */
export async function callModelOnce(opts: LlmOnceOpts): Promise<LlmOnceResult> {
  // 离线 token 包：model 前缀 offline: → 本地 LLM 通道（/compact 摘要、llmSpec 规格化
  // 等全部单轮调用断网可用）
  if (opts.model.startsWith('offline:')) {
    const { callOfflineLlm } = await import('./offlineModel.js');
    const r = await callOfflineLlm(opts.model, { messages: opts.messages, timeoutMs: opts.timeoutMs });
    return r.ok ? { ok: true, content: r.content } : { ok: false, error: r.error };
  }
  const httpReq = buildChatRequest({
    baseURL: opts.baseURL,
    model: opts.model,
    key: opts.key,
    messages: opts.messages,
    stream: false,
    temperature: opts.temperature ?? 0.7,
    responseFormat: opts.responseFormat,
  });
  let resp: Response;
  try {
    resp = await fetch(httpReq.url, {
      method: 'POST',
      headers: httpReq.headers,
      body: httpReq.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e: any) {
    return { ok: false, error: `请求失败：${String(e?.message ?? e).slice(0, 200)}` };
  }
  if (!resp.ok) return { ok: false, error: mapHttpError(resp.status) };
  try {
    const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = String(j?.choices?.[0]?.message?.content ?? '').trim();
    return content ? { ok: true, content } : { ok: false, error: '模型返回空内容' };
  } catch {
    return { ok: false, error: '响应解析失败（非 JSON）' };
  }
}

/** 从模型输出中提取 JSON 对象（容错：剥离 markdown 代码围栏与前后噪声）——结构化输出调用方共用 */
export function extractJson(s: string): Record<string, unknown> | null {
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
