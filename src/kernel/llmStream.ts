// src/kernel/llmStream.ts — LLM streaming transport and strict SSE parser
import { buildChatRequest, mapHttpError, MODEL_CATALOG, type ChatMessage } from './providers.js';

const REASONING_FIELDS = ['reasoning_content', 'thinking_content', 'reasoning'] as const;
const MAX_ATTEMPTS = 4;
const MAX_TOOL_CALLS = 64;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 10_000;

type FailureKind =
  | 'http-401'
  | 'http-403'
  | 'http-404'
  | 'http-413'
  | 'http-429'
  | 'http-500'
  | 'http-503'
  | 'connect'
  | 'abort'
  | 'malformed-sse'
  | 'premature-eof'
  | 'stream-error';

interface StreamFailure {
  ok: false;
  kind: FailureKind;
  error: string;
  status?: number;
  retryAfterMs?: number;
  semanticDelta: boolean;
}

interface StreamSuccess {
  ok: true;
  content: string;
  reasoning?: string;
  reasoningField?: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: LlmUsage;
}

type AttemptResult = StreamFailure | StreamSuccess;
type LlmUsage = { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; reasoningTokens: number };

/** Compatibility hook retained for callers. Degradation is now scoped to each call. */
export function resetDegradedModel(): void {
  // Intentionally empty: there is no process-global degradation state to reset.
}

export interface LlmStreamOpts {
  baseURL: string;
  model: string;
  key: string;
  messages: ChatMessage[];
  tools?: unknown[];
  /** User cancellation signal, combined with the request timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
  onToken?: (t: string) => void;
  onReasoning?: (t: string) => void;
  /** Called before an attempt switches to a fallback model. */
  onDegrade?: (from: string, to: string, status: number) => void;
}

export type LlmStreamResult =
  | {
      ok: true;
      content: string;
      reasoning?: string;
      reasoningField?: string;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
      usage?: LlmUsage;
      model: string;
    }
  | { ok: false; error: string; status?: number };

function classifyHttp(status: number, retryAfterMs?: number): StreamFailure {
  const knownKind: Partial<Record<number, FailureKind>> = {
    401: 'http-401',
    403: 'http-403',
    404: 'http-404',
    413: 'http-413',
    429: 'http-429',
    500: 'http-500',
    503: 'http-503',
  };
  return {
    ok: false,
    kind: knownKind[status] ?? (status >= 500 ? 'http-500' : 'stream-error'),
    error: mapHttpError(status),
    status,
    retryAfterMs,
    semanticDelta: false,
  };
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.min(Math.max(Number(trimmed) * 1000, 0), MAX_BACKOFF_MS);
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(date - now, 0), MAX_BACKOFF_MS);
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
}

function failureFromException(error: unknown, signal: AbortSignal, semanticDelta = false): StreamFailure {
  if (isAbortError(error, signal)) {
    return { ok: false, kind: 'abort', error: '请求已中止', semanticDelta };
  }
  const message = String((error as { message?: unknown })?.message ?? error).slice(0, 200);
  return { ok: false, kind: 'connect', error: `连接失败：${message}`, semanticDelta };
}

function isRetryable(failure: StreamFailure): boolean {
  return failure.kind === 'http-429' || failure.kind === 'http-500' || failure.kind === 'http-503' ||
    failure.kind === 'connect' || failure.kind === 'malformed-sse' || failure.kind === 'premature-eof';
}

function retryDelayMs(failure: StreamFailure, retryNumber: number): number {
  if (failure.retryAfterMs !== undefined) return failure.retryAfterMs;
  const exponential = Math.min(BASE_BACKOFF_MS * (2 ** (retryNumber - 1)), MAX_BACKOFF_MS);
  return Math.min(Math.round(exponential * (1 + Math.random())), MAX_BACKOFF_MS);
}

async function abortableWait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (ms <= 0) return true;
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function fallbackModels(model: string): string[] {
  const provider = MODEL_CATALOG.find(entry => entry.modelId === model)?.provider;
  if (!provider) return [];
  return MODEL_CATALOG
    .filter(entry => entry.provider === provider && entry.modelId !== model && !entry.capabilities?.imageIn)
    .slice(0, MAX_ATTEMPTS - 2)
    .map(entry => entry.modelId);
}

function malformedSse(message: string, semanticDelta: boolean): StreamFailure {
  return { ok: false, kind: 'malformed-sse', error: `SSE 格式错误：${message}`, semanticDelta };
}

function parseUsage(value: Record<string, unknown>): LlmUsage {
  const details = value.completion_tokens_details as Record<string, unknown> | undefined;
  return {
    promptTokens: typeof value.prompt_tokens === 'number' ? value.prompt_tokens : 0,
    completionTokens: typeof value.completion_tokens === 'number' ? value.completion_tokens : 0,
    cacheHitTokens: typeof value.prompt_cache_hit_tokens === 'number' ? value.prompt_cache_hit_tokens : 0,
    cacheMissTokens: typeof value.prompt_cache_miss_tokens === 'number' ? value.prompt_cache_miss_tokens : 0,
    reasoningTokens: typeof details?.reasoning_tokens === 'number' ? details.reasoning_tokens : 0,
  };
}

async function parseSse(response: Response, opts: LlmStreamOpts, signal: AbortSignal): Promise<AttemptResult> {
  if (!response.body) {
    return { ok: false, kind: 'premature-eof', error: '模型响应体为空', semanticDelta: false };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    return {
      ok: false,
      kind: 'premature-eof',
      error: `流读取失败：${String((error as { message?: unknown })?.message ?? error).slice(0, 200)}`,
      semanticDelta: false,
    };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let reasoningField: string | undefined;
  let usage: LlmUsage | undefined;
  let doneSeen = false;
  let semanticDelta = false;
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  const processFrame = (rawFrame: string): StreamFailure | undefined => {
    const frame = rawFrame.replace(/\r\n/g, '\n');
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return undefined;
    if (doneSeen) return malformedSse('在 [DONE] 后收到 data 帧', semanticDelta);

    const data = dataLines.join('\n');
    if (data.trim() === '[DONE]') {
      doneSeen = true;
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return malformedSse('data 不是有效 JSON', semanticDelta);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return malformedSse('data JSON 必须是对象', semanticDelta);
    }

    const event = parsed as Record<string, unknown>;
    const eventError = event.error as Record<string, unknown> | string | undefined;
    if (eventError) {
      const detail = typeof eventError === 'string' ? eventError : eventError.message ?? eventError.code ?? 'SSE 流错误';
      return {
        ok: false,
        kind: 'stream-error',
        error: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300),
        semanticDelta,
      };
    }
    if (typeof event.usage === 'object' && event.usage !== null && !Array.isArray(event.usage)) {
      usage = parseUsage(event.usage as Record<string, unknown>);
    }

    const choices = event.choices;
    const choice = Array.isArray(choices) && typeof choices[0] === 'object' && choices[0] !== null
      ? choices[0] as Record<string, unknown>
      : undefined;
    const delta = typeof choice?.delta === 'object' && choice.delta !== null
      ? choice.delta as Record<string, unknown>
      : undefined;
    const fragments = delta?.tool_calls;
    if (Array.isArray(fragments)) {
      if (fragments.length > MAX_TOOL_CALLS) {
        return malformedSse(`单个 delta 的 tool_calls 超过 ${MAX_TOOL_CALLS} 个`, semanticDelta);
      }
      for (const rawFragment of fragments) {
        if (typeof rawFragment !== 'object' || rawFragment === null) continue;
        const fragment = rawFragment as Record<string, unknown>;
        if (fragment.index !== undefined &&
            (!Number.isSafeInteger(fragment.index) || (fragment.index as number) < 0 || (fragment.index as number) >= MAX_TOOL_CALLS)) {
          return malformedSse(`tool_calls index 必须是 0..${MAX_TOOL_CALLS - 1} 的安全整数`, semanticDelta);
        }
      }
    }
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      semanticDelta = true;
      content += delta.content;
      opts.onToken?.(delta.content);
    }
    for (const field of REASONING_FIELDS) {
      const value = delta?.[field];
      if (typeof value === 'string' && value.length > 0) {
        semanticDelta = true;
        reasoningField ??= field;
        reasoning += value;
        opts.onReasoning?.(value);
        break;
      }
    }

    if (Array.isArray(fragments)) {
      for (const rawFragment of fragments) {
        if (typeof rawFragment !== 'object' || rawFragment === null) continue;
        const fragment = rawFragment as Record<string, unknown>;
        const fn = typeof fragment.function === 'object' && fragment.function !== null
          ? fragment.function as Record<string, unknown>
          : undefined;
        const hasFragment = typeof fragment.id === 'string' || typeof fn?.name === 'string' || typeof fn?.arguments === 'string';
        if (!hasFragment) continue;
        const index = typeof fragment.index === 'number' ? fragment.index : 0;
        semanticDelta = true;
        toolCalls[index] ??= { id: '', name: '', arguments: '' };
        if (typeof fragment.id === 'string') toolCalls[index]!.id += fragment.id;
        if (typeof fn?.name === 'string') toolCalls[index]!.name += fn.name;
        if (typeof fn?.arguments === 'string') toolCalls[index]!.arguments += fn.arguments;
      }
    }

    if (choice?.finish_reason === 'error' && !semanticDelta) {
      return { ok: false, kind: 'stream-error', error: '模型流结束于错误状态（无输出）', semanticDelta: false };
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const failure = processFrame(frame);
        if (failure) return failure;
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (isAbortError(error, signal)) return failureFromException(error, signal, semanticDelta);
    return {
      ok: false,
      kind: 'premature-eof',
      error: `流读取失败：${String((error as { message?: unknown })?.message ?? error).slice(0, 200)}`,
      semanticDelta,
    };
  }

  if (buffer.trim().length > 0) return malformedSse('流末尾存在未完成帧', semanticDelta);
  if (!doneSeen) {
    return { ok: false, kind: 'premature-eof', error: '模型流在 [DONE] 前提前结束', semanticDelta };
  }
  if (!semanticDelta) {
    return { ok: false, kind: 'stream-error', error: '模型返回空响应', semanticDelta: false };
  }
  return {
    ok: true,
    content,
    reasoning: reasoning || undefined,
    reasoningField,
    toolCalls: toolCalls.filter(call => call.id || call.name || call.arguments),
    usage,
  };
}

async function attemptModel(model: string, opts: LlmStreamOpts, signal: AbortSignal): Promise<AttemptResult> {
  const request = buildChatRequest({
    baseURL: opts.baseURL,
    model,
    key: opts.key,
    messages: opts.messages,
    stream: true,
    tools: opts.tools,
  });
  let response: Response;
  try {
    response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal });
  } catch (error) {
    return failureFromException(error, signal);
  }
  if (!response.ok) {
    return classifyHttp(response.status, parseRetryAfter(response.headers?.get('retry-after') ?? null, Date.now()));
  }
  return parseSse(response, opts, signal);
}

/** Stream one chat completion. Failures are returned rather than thrown. */
export async function callLlmStream(opts: LlmStreamOpts): Promise<LlmStreamResult> {
  if (opts.model.startsWith('offline:')) {
    const { callOfflineLlm } = await import('./offlineModel.js');
    const result = await callOfflineLlm(opts.model, {
      messages: opts.messages,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onToken: opts.onToken,
      onReasoning: opts.onReasoning,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      content: result.content,
      toolCalls: [],
      usage: result.usage ? { ...result.usage, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 } : undefined,
      model: opts.model,
    };
  }

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  const models = [opts.model, opts.model, ...fallbackModels(opts.model)].slice(0, MAX_ATTEMPTS);
  let lastFailure: StreamFailure | undefined;

  for (let attempt = 0; attempt < models.length; attempt++) {
    const model = models[attempt]!;
    if (attempt > 1) {
      opts.onDegrade?.(opts.model, model, lastFailure?.status ?? 0);
    }
    const result = await attemptModel(model, opts, signal);
    if (result.ok) return { ...result, model };
    lastFailure = result;
    if (result.kind === 'abort' || result.semanticDelta || !isRetryable(result) || attempt === models.length - 1) break;
    const waited = await abortableWait(retryDelayMs(result, attempt + 1), signal);
    if (!waited) {
      lastFailure = { ok: false, kind: 'abort', error: '请求已中止', semanticDelta: false };
      break;
    }
  }

  return {
    ok: false,
    error: lastFailure?.error ?? '模型请求失败',
    status: lastFailure?.status,
  };
}
