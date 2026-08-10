// src/kernel/agent.ts — L2-4 agent 循环（核心）
// 设计（参考 ReAct 模式 + 事件驱动 harness + turn 控制器思想）：
//   run(prompt) 循环（≤16 轮）：
//     召回注入（黑洞引擎 FTS）→ 调模型（流式/工具）→ 文本流经事件总线
//     → 工具调用：permissions 检查 → 执行（danger 结果 untrusted 包裹）→ 回填
//     → 同工具连续失败 5 次终止 / 未知工具连续 3 轮终止 / 瞬时失败 800ms 退避重试
//   无 key → 规则脑兜底（诚实回答）
//   spawnSubagent：独立上下文 + 只读工具集
import type { Db } from '../store/db.js';
import type { EventBus } from './events.js';
import type { Memory } from './memory.js';
import { decryptKey, REASONING_FIELDS } from './providers.js';
import { estimateMessagesTokens, compactMessages } from './memory.js';
import { coreTools, isDangerous, toolsToOpenAI, type ToolCtx } from './tools.js';
import { modeVerdict, type Mode } from './permissions.js';
import type { HookRunner } from './hooks.js';
import { join } from 'node:path';

export interface ModelCall { type: 'text'; content: string; reasoning?: string; reasoningField?: string }
export interface ToolCallMsg { type: 'tool_call'; name: string; args: Record<string, any>; id?: string; reasoning?: string; reasoningField?: string }

export interface AgentOptions {
  db: Db;
  bus: EventBus;
  mem: Memory;
  sessionId: string;
  config: { settings: { apiKeyEnc?: string | null; baseURL?: string; model?: string } };
  callModel?: ((req: { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] }, streamCtx?: { onToken?: (t: string) => void }) => Promise<ModelCall | ToolCallMsg>) | null;
  mode?: Mode;
  onApproval?: (tool: string, args: Record<string, any>) => Promise<boolean>;
  maxTurns?: number;
  /** 生命周期 hooks（本地命令执行）；缺省关闭 */
  hooks?: HookRunner | null;
  /** 附加工具（如 MCP 客户端工具表 mcp__<server>__<tool>） */
  extraTools?: Record<string, import('./tools.js').ToolDef>;
  /** 上下文窗口上限（自动压缩触发阈值基准，默认 64k） */
  maxContextTokens?: number;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  turns: number;
  interrupted: boolean;
}

const MAX_TURNS = 16;
const RETRY_DELAY_MS = 800;
const MAX_CONSECUTIVE_FAIL = 5;
const MAX_UNKNOWN_TOOL_ROUNDS = 3;

/** 可重建的 abort 信号：Promise.race 一次性语义要求每轮新建 promise。 */
function makeAbortSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

export function createAgent(opts: AgentOptions) {
  const tools = { ...coreTools(), ...(opts.extraTools ?? {}) };
  const bus = opts.bus;
  let sessionId = opts.sessionId; // 可变：setSessionId 热切换（多会话）
  let mode = opts.mode ?? 'smart'; // 可变：/perm 切换经 setMode 热更新
  let aborted = false;
  let interrupted = false;
  // Hooks（生命周期本地命令）：settings.hooks 热生效——每次触发读当前配置
  const hooks = opts.hooks ?? null;
  // abort 信号：每轮 loop 重建——Promise.race 一旦 resolve 就永久 resolve，
  // 一次性 abortPromise 会让中断后的所有后续提问立即失败（"aborted"）。
  let abortSignal: { promise: Promise<void>; resolve: () => void } = makeAbortSignal();

  // 默认模型调用：OpenAI 兼容真流式（SSE）——token 逐块推送总线（UI 实时显示）
  // 工具调用解析保留 tool_call id（严格格式：assistant.tool_calls + tool.tool_call_id 回填）
  const defaultCallModel = async (
    req: { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] },
    streamCtx?: { onToken?: (t: string) => void },
  ): Promise<ModelCall | ToolCallMsg> => {
    const s = opts.config.settings;
    let key: string | null = null;

    if (s.apiKeyEnc) {
      key = decryptKey(s.apiKeyEnc);
      // 有 enc 但解密失败（机器指纹变化/数据损坏）——明确提示重新配置，
      // 而不是误导性的「未配置」
      if (!key) {
        return { type: 'text', content: '密钥无法解密（机器环境变化或数据损坏？）——请用 /key set <密钥> 重新配置。' };
      }
    }

    if (!key) {
      // 无 key：所有对话输出必须经 AI 模型——不做规则脑假装回答，
      // 明确引导配置（配置类命令 /key 等仍本地可用）
      const q = req.messages[req.messages.length - 1]?.content ?? '';
      return {
        type: 'text',
        content: q.trim()
          ? '当前未配置模型密钥，所有回答需要 AI 模型提供。请用 /key set <密钥> 配置后重试（配置类命令不受影响）。'
          : '（空输入）',
      };
    }

    const { buildChatRequest, mapHttpError, MODEL_CATALOG } = await import('./providers.js');
    // 有 key 即视为已配置：model/baseURL 缺失或非法（遗留命令串）时用默认，
    // 不降级规则脑——否则 /key 配置后仍提示「未配置」或 API 模型名非法
    const baseURL = s.baseURL || 'https://api.deepseek.com/v1';
    const model = MODEL_CATALOG.some(m => m.modelId === s.model) ? s.model! : 'deepseek-v4-flash';
    const httpReq = buildChatRequest({ baseURL, model, key, messages: req.messages as any, stream: true, tools: req.tools });
    const resp = await fetch(httpReq.url, { method: 'POST', headers: httpReq.headers, body: httpReq.body, signal: AbortSignal.timeout(120000) });
    if (!resp.ok) {
      const err = new Error(mapHttpError(resp.status)) as Error & { status?: number };
      err.status = resp.status;
      throw err;
    }

    // SSE 流式解析：delta.content 逐块推送 / delta.tool_calls 按 index 累积
    // 思考模式字段多 provider 适配：按别名表识别「首个命中的字段」（deepseek/kimi/GLM
    // 共用 reasoning_content，未来厂商可能用 thinking_content），回传时用同名字段——
    // 思考模式必须回传（deepseek 实测否则 400），原字段名回传保证各家兼容
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let fullReasoning = '';
    let reasoningField: string | null = null;
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let finished = false;

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
        const delta = j?.choices?.[0]?.delta;
        if (delta?.content) {
          full += delta.content;
          streamCtx?.onToken?.(delta.content);
        }
        // 思考字段别名探测（reasoning_content / thinking_content / reasoning）
        for (const f of REASONING_FIELDS) {
          const v = delta?.[f];
          if (typeof v === 'string' && v) {
            reasoningField ??= f;
            fullReasoning += v;
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
      }
    }

    if (toolCalls.length && (toolCalls[0]!.name || toolCalls[0]!.arguments)) {
      const tc = toolCalls[0]!;
      return { type: 'tool_call', id: tc.id || `call_${Date.now().toString(36)}`, name: tc.name, args: safeJson(tc.arguments), reasoning: fullReasoning || undefined, reasoningField: reasoningField ?? undefined };
    }
    return { type: 'text', content: full, reasoning: fullReasoning || undefined, reasoningField: reasoningField ?? undefined };
  };
  const callModel = opts.callModel ?? defaultCallModel;

  // 子代理：独立只读上下文（spawnSubagent 与 delegate 工具共用）
  const spawnSub = async (goal: string): Promise<{ ok: boolean; output: string; turns: number }> => {
    const r = await loop(sessionId + ':sub', goal, { subagent: true });
    return { ok: r.ok, output: r.text, turns: r.turns };
  };

  const toolCtx: ToolCtx = {
    cwd: process.cwd(),
    dataDir: join(process.cwd(), 'data'),
    ask: async (q) => (opts.onApproval ? opts.onApproval('ask_user', { question: q }) : false),
    spawnSubagent: spawnSub,
  };

  const onApproval = opts.onApproval ?? (async () => true);

  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    bus.emit('agent.tool', { name, args, phase: 'start' });
    try {
      const verdict = modeVerdict(mode, name, args);
      if (verdict === 'reject') return `工具被拒绝：权限红线（${name}）`;
      // plan 模式语义是「只读研究 + 计划审批」：所有非只读动作都必须确认
      // （与 confirm 同路径——审批桥弹出确认；拒绝则不执行）
      if (verdict === 'confirm' || verdict === 'plan') {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
      }
      // PreToolUse hook：输出 DENY 即真实拦截（权限门之后、执行之前）
      if (hooks) {
        const allowed = await hooks.preToolUse(name, args);
        if (!allowed) {
          bus.emit('agent.tool', { name, phase: 'complete', ok: false });
          return `工具被 hook 拒绝（${name}）`;
        }
      }
      const tool = tools[name];
      if (!tool) return `未知工具：${name}`;
      const out = await tool.run(args, toolCtx);
      bus.emit('agent.tool', { name, phase: 'complete', ok: true, ms: 0 });
      hooks?.postToolUse(name, out);
      return out;
    } catch (e: any) {
      bus.emit('agent.tool', { name, phase: 'complete', ok: false });
      return `工具执行异常：${e?.message?.slice(0, 300) ?? e}`;
    }
  }

  async function loop(sessionId: string, prompt: string, opts2: { subagent?: boolean } = {}): Promise<AgentResult> {
    aborted = false;
    interrupted = false;
    // 每轮重建 abort 信号（见 makeAbortSignal 注释）
    abortSignal = makeAbortSignal();
    // 子代理生命周期事件（UI agentsOverlay / spawnHistoryStore 消费）
    if (opts2.subagent) {
      bus.emit('agent.subagent', { goal: prompt, phase: 'start', session_id: sessionId });
    }
    const callWithAbort = (req: { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] }) =>
      Promise.race([
        // 真流式：SSE token 逐块推送总线（UI 实时显示运行状态）
        callModel(req, { onToken: (t) => bus.emit('agent.token', { text: t }) }),
        abortSignal.promise.then(() => { throw new Error('aborted'); }),
      ]);
    const msgs: Array<{ role: string; content: string | null; tool_call_id?: string; reasoning_content?: string; thinking_content?: string; reasoning?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }> = [];
    // 召回注入（黑洞引擎：FTS 命中历史上下文）
    const recalled = opts.mem.recallHybrid(prompt, { limit: 3 });
    const recallBlock = recalled.length
      ? `\n[相关历史记忆]\n${recalled.map(r => r.content.slice(0, 300)).join('\n---\n')}`
      : '';
    msgs.push({ role: 'user', content: prompt + recallBlock });
    try { opts.mem.append(sessionId, 'user', prompt); } catch { /* 记忆写入失败不阻断对话 */ }
    const toolList = opts2.subagent ? toolsToOpenAI(Object.fromEntries(Object.entries(tools).filter(([n]) => !['fs_write', 'fs_edit', 'bash', 'scaffold_build', 'delegate'].includes(n)))) : toolsToOpenAI(tools);
    let turns = 0;
    let consecutiveFail = 0;
    let unknownRounds = 0;
    let finalText = '';
    bus.emit('agent.start', { sessionId, prompt });
    hooks?.userPromptSubmit(prompt, sessionId);

    try {
    while (turns < (opts.maxTurns ?? MAX_TURNS)) {
      if (aborted) { interrupted = true; break; }
      turns++;
      // 自动压缩触发（机制补强）：每轮调用前估算上下文，超过模型窗口阈值
      // （默认 max×0.85 或 +reserved>=max）→ 自动压缩内存消息后继续当前回合
      const ctxLimit = opts2.subagent ? 64_000 : (opts.maxContextTokens ?? 64_000);
      const used = estimateMessagesTokens(msgs);
      if (used > ctxLimit * 0.85 && msgs.length > 10) {
        bus.emit('system.notice', { text: `上下文已达 ${Math.round((used / ctxLimit) * 100)}%（${used} token）——自动压缩…` });
        const condensed = await compactMessages(msgs as any, async (text) => {
          const r = await callWithAbort({
            messages: [
              { role: 'system', content: '你是上下文压缩器。把对话片段压缩为保留关键信息的摘要（中文，≤300 字），只输出摘要。' },
              { role: 'user', content: text },
            ],
            tools: [],
          });
          return r.type === 'text' ? r.content : '';
        });
        msgs.splice(0, msgs.length, ...condensed);
        bus.emit('system.notice', { text: `自动压缩完成（${used} → ${estimateMessagesTokens(msgs)} token）` });
      }
      let res: ModelCall | ToolCallMsg;
      try {
        res = await callWithAbort({ messages: msgs, tools: toolList });
      } catch (e: any) {
        if (aborted) { interrupted = true; break; }
        // 4xx 确定性错误（密钥无效/模型不存在/请求非法等）：不重试，立即反馈——
        // 否则无效 key 会空转 ~6s（3 次退避重试）才显示错误，被误判为「卡死」。
        // 429 限流除外：mapHttpError 语义为稍后重试，保留退避重试。
        if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 429) {
          bus.emit('agent.error', { message: String(e?.message ?? e) });
          return { ok: false, text: `模型调用失败：${e?.message?.slice(0, 200)}`, turns, interrupted };
        }
        // 瞬时失败：800ms 退避重试（最多 3 次）
        let tried = 0;
        let lastErr = e;
        while (tried < 3) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (tried + 1)));
          try { res = await callWithAbort({ messages: msgs, tools: toolList }); break; }
          catch (e2: any) { if (aborted) { interrupted = true; break; } lastErr = e2; tried++; }
        }
        if (interrupted) break;
        if (tried >= 3) {
          bus.emit('agent.error', { message: String(lastErr?.message ?? lastErr) });
          return { ok: false, text: `模型调用失败：${lastErr?.message?.slice(0, 200)}`, turns, interrupted };
        }
        continue;
      }
      if (res.type === 'text') {
        finalText = res.content;
        // 思考模式回传：用模型返回的原始字段名（reasoning_content/thinking_content 等）
        // 多 provider 适配——deepseek 实测必须回传否则 400；原字段名回传各家兼容
        msgs.push(res.reasoning
          ? { role: 'assistant', content: res.content, [res.reasoningField ?? 'reasoning_content']: res.reasoning }
          : { role: 'assistant', content: res.content });
        try { opts.mem.append(sessionId, 'assistant', res.content); } catch { /* 忽略 */ }
        // token 已由流式 onToken 实时推送（此处不再事后模拟）
        bus.emit('agent.message', { content: res.content });
        break; // 文本 = 回合结束
      }
      // 工具调用（严格 OpenAI 格式：assistant.tool_calls + tool.tool_call_id 回填）
      if (res.type === 'tool_call') {
        const tool = tools[res.name];
        if (!tool) {
          unknownRounds++;
          if (unknownRounds >= MAX_UNKNOWN_TOOL_ROUNDS) {
            bus.emit('agent.error', { message: `连续 ${MAX_UNKNOWN_TOOL_ROUNDS} 轮未知工具，终止` });
            return { ok: false, text: '模型连续调用未知工具，已终止', turns, interrupted };
          }
          msgs.push({ role: 'assistant', content: `工具 ${res.name} 不存在` });
          continue;
        }
        unknownRounds = 0;
        const callId = res.id ?? `call_${Date.now().toString(36)}${turns}`;
        const out = await executeTool(res.name, res.args);
        consecutiveFail = out.includes('失败') || out.includes('异常') ? consecutiveFail + 1 : 0;
        if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
          bus.emit('agent.error', { message: `同工具连续失败 ${MAX_CONSECUTIVE_FAIL} 次，终止` });
          return { ok: false, text: '同工具连续失败 5 次，已终止', turns, interrupted };
        }
        msgs.push({
          role: 'assistant',
          content: '',
          ...(res.reasoning ? { [res.reasoningField ?? 'reasoning_content']: res.reasoning } : {}),
          tool_calls: [{ id: callId, type: 'function', function: { name: res.name, arguments: JSON.stringify(res.args) } }],
        });
        msgs.push({ role: 'tool', tool_call_id: callId, content: out });
        try { opts.mem.append(sessionId, 'tool', `${res.name}: ${out.slice(0, 300)}`); } catch { /* 忽略 */ }
      }
    }
    // 自动标题（机制补强）：回合结束后若会话无标题，用首条用户消息前 20 字命名
    if (!opts2.subagent && finalText.length > 0) {
      try {
        const title = prompt.split('\n')[0]!.trim().slice(0, 20) || '新会话';
        opts.mem.setTitleIfEmpty(sessionId, title);
      } catch { /* 标题写入失败不阻断 */ }
    }
    bus.emit('agent.end', { ok: finalText.length > 0, turns });
    return { ok: finalText.length > 0, text: finalText, turns, interrupted };
    } finally {
      // Stop hook：无论正常结束/中断/提前 return 都触发（不改 agent.end 总线语义）
      hooks?.stop({ ok: finalText.length > 0, turns });
      if (opts2.subagent) {
        bus.emit('agent.subagent', { goal: prompt, phase: 'complete', ok: finalText.length > 0, turns, session_id: sessionId });
      }
    }
  }

  return {
    async run(prompt: string): Promise<AgentResult> {
      return loop(sessionId, prompt);
    },
    spawnSubagent: spawnSub,
    abort() { aborted = true; abortSignal.resolve(); },
    setMode(m: Mode) { mode = m; },
    getMode(): Mode { return mode; },
    // 会话切换：多会话 UI 复用同一 agent 实例（消息经 mem.append 落库到目标会话）
    setSessionId(id: string) { sessionId = id; },
  };
}

function safeJson(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}
