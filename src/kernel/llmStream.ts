// src/kernel/llmStream.ts — LLM 流式调用服务（架构 P2：从 agent.ts 抽取）
// 职责：buildChatRequest → fetch（abort+超时）→ 模型降级链（429/5xx 同 provider 备选）
//       → SSE 流式解析（content/reasoning/tool_calls 分片累积 + 用量提取）→ 结构化结果。
// agent 循环只消费结果；/arena 等未来多模型路由复用同一服务。
import { buildChatRequest, mapHttpError, MODEL_CATALOG, type ChatMessage } from './providers.js';

/** 思考字段别名表（deepseek/kimi/GLM 共用 reasoning_content；未来厂商 thinking_content） */
const REASONING_FIELDS = ['reasoning_content', 'thinking_content', 'reasoning'] as const;

/** 进程内降级状态：同 provider 备选重试一次后记录（/model 切换或会话切换可复位） */
let degradedModel: string | null = null;

/** 429 退避重试状态：每次调用只重试一次（防重试风暴） */
let retried429 = false;

/** 复位降级状态（/model 手动切换、会话切换时调用） */
export function resetDegradedModel(): void {
  degradedModel = null;
}

export interface LlmStreamOpts {
  baseURL: string;
  model: string;
  key: string;
  messages: ChatMessage[];
  tools?: unknown[];
  /** 用户中断信号（与超时合并） */
  signal?: AbortSignal;
  timeoutMs?: number;
  onToken?: (t: string) => void;
  onReasoning?: (t: string) => void;
  /** 降级发生回调（通知 UI/日志） */
  onDegrade?: (from: string, to: string, status: number) => void;
}

export type LlmStreamResult =
  | {
      ok: true;
      content: string;
      reasoning?: string;
      reasoningField?: string;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
      /** 流尾 usage（OpenAI 兼容）；缺失时 undefined。cacheHit/cacheMiss 为前缀缓存命中/未命中 token，
       *  reasoningTokens 为推理 token（completion_tokens_details.reasoning_tokens；端点未上报时 0）。 */
      usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; reasoningTokens: number };
      /** 实际使用的模型（降级后为备选） */
      model: string;
    }
  | { ok: false; error: string; status?: number };

/** 流式单轮调用（直连 fetch；失败返回错误对象不抛出——调用方决定语义） */
export async function callLlmStream(opts: LlmStreamOpts): Promise<LlmStreamResult> {
  retried429 = false; // 每次调用只允许一次 429 退避重试（防重试风暴）
  // 离线 token 包：model 前缀 offline: → 本地 LLM 通道（transformers.js，断网可用；
  // 无工具调用——agent 离线模式为纯文本对话，工具类任务由确定性工具兜底）
  if (opts.model.startsWith('offline:')) {
    const { callOfflineLlm } = await import('./offlineModel.js');
    const r = await callOfflineLlm(opts.model, {
      messages: opts.messages,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onToken: opts.onToken,
      onReasoning: opts.onReasoning,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // 离线本地模型无云端缓存/推理语义——缓存与推理字段归零
    return { ok: true, content: r.content, toolCalls: [], usage: r.usage ? { ...r.usage, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 } : undefined, model: opts.model };
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const fetchSignal = opts.signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])
    : AbortSignal.timeout(timeoutMs);

  const httpReq = buildChatRequest({
    baseURL: opts.baseURL,
    model: opts.model,
    key: opts.key,
    messages: opts.messages,
    stream: true,
    tools: opts.tools,
  });
  let resp = await fetch(httpReq.url, { method: 'POST', headers: httpReq.headers, body: httpReq.body, signal: fetchSignal });
  let usedModel = opts.model;

  // 429 同模型退避重试（一次）：瞬时限流常见——尊重 Retry-After（上限 10s），
  // 失败再走降级链（档案/自定义端点无备选模型时也能扛住瞬时 429）
  if (!resp.ok && resp.status === 429 && !retried429) {
    retried429 = true;
    const ra = Number(resp.headers?.get?.('retry-after'));
    const delay = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000, 10_000);
    await new Promise(res => setTimeout(res, delay));
    resp = await fetch(httpReq.url, { method: 'POST', headers: httpReq.headers, body: httpReq.body, signal: fetchSignal }).catch(() => resp);
  }

  // 模型降级链：429/5xx 且未降级 → 同 provider 备选模型重试（单 key 语义，/model 可复位）
  if (!resp.ok && (resp.status === 429 || resp.status >= 500) && !degradedModel) {
    const provider = MODEL_CATALOG.find(m => m.modelId === opts.model)?.provider ?? '';
    const fallbacks = MODEL_CATALOG.filter(m => m.provider === provider && m.modelId !== opts.model && !m.capabilities?.imageIn).slice(0, 2);
    for (const fb of fallbacks) {
      opts.onDegrade?.(opts.model, fb.modelId, resp.status);
      const fbReq = buildChatRequest({
        baseURL: opts.baseURL, model: fb.modelId, key: opts.key,
        messages: opts.messages, stream: true, tools: opts.tools,
      });
      const r2 = await fetch(fbReq.url, { method: 'POST', headers: fbReq.headers, body: fbReq.body, signal: fetchSignal }).catch(() => null);
      if (r2?.ok) { degradedModel = fb.modelId; usedModel = fb.modelId; resp = r2; break; }
    }
  }
  if (!resp.ok) {
    return { ok: false, error: mapHttpError(resp.status), status: resp.status };
  }

  // SSE 流式解析：delta.content 逐块推送 / delta.tool_calls 按 index 累积
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let fullReasoning = '';
  let reasoningField: string | null = null;
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; reasoningTokens: number } | null = null;
  let finished = false;

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { finished = true; break; }
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        // SSE 错误对象（上下文超限等）不得静默吞掉——走错误反馈路径
        if (j?.error) {
          const msg = j.error?.message ?? j.error?.code ?? 'SSE 流错误';
          return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300) };
        }
        if (j?.usage) {
          // 成本五维（supremacy 1.4）：输入/输出/缓存命中/缓存未命中/推理 token
          // （DeepSeek 自动前缀缓存 + completion_tokens_details.reasoning_tokens；端点未上报字段为 0）
          usage = {
            promptTokens: j.usage.prompt_tokens ?? 0,
            completionTokens: j.usage.completion_tokens ?? 0,
            cacheHitTokens: j.usage.prompt_cache_hit_tokens ?? 0,
            cacheMissTokens: j.usage.prompt_cache_miss_tokens ?? 0,
            reasoningTokens: j.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          };
        }
        const delta = j?.choices?.[0]?.delta;
        const finishReason = j?.choices?.[0]?.finish_reason;
        if (delta?.content) {
          full += delta.content;
          opts.onToken?.(delta.content);
        }
        // 思考字段别名探测（原字段名回传保证各家兼容——deepseek 实测否则 400）
        for (const f of REASONING_FIELDS) {
          const v = delta?.[f];
          if (typeof v === 'string' && v) {
            reasoningField ??= f;
            fullReasoning += v;
            opts.onReasoning?.(v);
            break;
          }
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc?.index ?? 0;
            toolCalls[i] ??= { id: '', name: '', arguments: '' };
            if (tc.id) toolCalls[i]!.id = tc.id;
            if (tc.function?.name) toolCalls[i]!.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i]!.arguments += tc.function.arguments;
          }
        }
        // finish_reason=error 且无内容 → 视为错误
        if (finishReason === 'error' && !full) {
          return { ok: false, error: '模型流结束于错误状态（无输出）' };
        }
      }
    }
  } catch (e: any) {
    return { ok: false, error: `流读取失败：${String(e?.message ?? e).slice(0, 200)}` };
  }

  // 正常结束但空内容（无 token 无工具调用）→ 错误而非静默空消息
  if (!full && !toolCalls.length) {
    return { ok: false, error: '模型返回空响应' };
  }

  return {
    ok: true,
    content: full,
    reasoning: fullReasoning || undefined,
    reasoningField: reasoningField ?? undefined,
    toolCalls: toolCalls.filter(tc => tc.name || tc.arguments),
    usage: usage ?? undefined,
    model: usedModel,
  };
}
