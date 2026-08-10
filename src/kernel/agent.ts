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
import { coreTools, isDangerous, toolsToOpenAI, wrapDanger, type ToolCtx } from './tools.js';
import { modeVerdict, type Mode } from './permissions.js';
import type { HookRunner } from './hooks.js';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';

export interface ModelCall { type: 'text'; content: string; reasoning?: string; reasoningField?: string }
export interface ToolCallMsg { type: 'tool_call'; name: string; args: Record<string, any>; id?: string; reasoning?: string; reasoningField?: string; calls?: Array<{ id: string; name: string; args: Record<string, any>; reasoning?: string; reasoningField?: string }> }

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
  /** 排除的工具名（子代理收窄工具集用） */
  excludeTools?: string[];
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

// 项目引导注入（对比轮 5 修复）：运行时加载 <cwd>/AGENTS.md 进系统提示（kimi 对齐——
// 只生成不消费是缺口）。32KiB 预算，不存在/超限静默跳过；mtime 缓存避免每轮重复读盘
let agentsMdCache: { path: string; mtime: number; text: string } | null = null;
function loadAgentsMd(cwd: string): string | null {
  try {
    const p = join(cwd, 'AGENTS.md');
    const st = statSync(p);
    if (st.size > 32768) return null;
    if (agentsMdCache && agentsMdCache.path === p && agentsMdCache.mtime === st.mtimeMs) return agentsMdCache.text;
    const text = readFileSync(p, 'utf8').slice(0, 32000);
    agentsMdCache = { path: p, mtime: st.mtimeMs, text };
    return text;
  } catch { return null; }
}

/** 可重建的 abort 信号：Promise.race 一次性语义要求每轮新建 promise。
 *  abortController 供真 AbortSignal（fetch/子进程中断）使用。 */
function makeAbortSignal(): { promise: Promise<void>; resolve: () => void; abortController: AbortController } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  const abortController = new AbortController();
  return { promise, resolve, abortController };
}

export function createAgent(opts: AgentOptions) {
  const tools = Object.fromEntries(
    Object.entries({ ...coreTools(), ...(opts.extraTools ?? {}) }).filter(([n]) => !(opts.excludeTools ?? []).includes(n)),
  );
  const bus = opts.bus;
  let sessionId = opts.sessionId; // 可变：setSessionId 热切换（多会话）
  let mode = opts.mode ?? 'smart'; // 可变：/perm 切换经 setMode 热更新
  let aborted = false;
  let interrupted = false;
  // Hooks（生命周期本地命令）：settings.hooks 热生效——每次触发读当前配置
  const hooks = opts.hooks ?? null;
  // abort 信号：每轮 loop 重建——Promise.race 一旦 resolve 就永久 resolve，
  // 一次性 abortPromise 会让中断后的所有后续提问立即失败（"aborted"）。
  let abortSignal: { promise: Promise<void>; resolve: () => void; abortController: AbortController } = makeAbortSignal();

  // 默认模型调用：OpenAI 兼容真流式（SSE）——token 逐块推送总线（UI 实时显示）
  // 工具调用解析保留 tool_call id（严格格式：assistant.tool_calls + tool.tool_call_id 回填）
  const defaultCallModel = async (
    req: { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] },
    streamCtx?: { onToken?: (t: string) => void; signal?: AbortSignal },
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
    // 修复 F3：abort 信号接入真实 fetch（AbortSignal.any 合并超时与用户中断）
    const fetchSignal = streamCtx?.signal
      ? AbortSignal.any([AbortSignal.timeout(120000), streamCtx.signal])
      : AbortSignal.timeout(120000);
    const resp = await fetch(httpReq.url, { method: 'POST', headers: httpReq.headers, body: httpReq.body, signal: fetchSignal });
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

    // 批量 tool_calls 全量返回（修复对比轮 5 缺口：同回合多工具调用不得丢弃——
    // OpenAI 流式按 index 累积全部 tool_calls，模型一次可并行请求多个工具）
    const valid = toolCalls.filter(tc => tc.name || tc.arguments);
    if (valid.length) {
      const calls = valid.map(tc => ({
        id: tc.id || `call_${Date.now().toString(36)}_${toolCalls.indexOf(tc)}`,
        name: tc.name,
        args: safeJson(tc.arguments),
        reasoning: fullReasoning || undefined,
        reasoningField: reasoningField ?? undefined,
      }));
      const first = calls[0]!;
      return { type: 'tool_call', id: first.id, name: first.name, args: first.args, reasoning: first.reasoning, reasoningField: first.reasoningField, calls };
    }
    return { type: 'text', content: full, reasoning: fullReasoning || undefined, reasoningField: reasoningField ?? undefined };
  };
  const callModel = opts.callModel ?? defaultCallModel;

  // 子代理（F9 修复）：独立 agent 实例（独立 abort 状态）+ 深度限制 + 收窄工具集
  // 工具集排除：写文件/执行/委派/记忆写入/外联/提问（只读探索）
  const SUBAGENT_EXCLUDE = ['fs_write', 'fs_edit', 'bash', 'scaffold_build', 'delegate', 'memory_write', 'http_get', 'ask_user'];
  const MAX_SUBAGENT_DEPTH = 3;
  const spawnSub = async (goal: string, depth = 1): Promise<{ ok: boolean; output: string; turns: number }> => {
    if (depth > MAX_SUBAGENT_DEPTH) {
      return { ok: false, output: `子代理深度超限（${MAX_SUBAGENT_DEPTH} 层）——请拆分子任务`, turns: 0 };
    }
    // 子代理生命周期事件（独立实例，手动发事件保持 UI 可见）
    bus.emit('agent.subagent', { goal, phase: 'start', session_id: sessionId + ':sub' });
    bus.emit('agent.stage', { stage: `子代理执行中（深度 ${depth}）…` }); // 对比轮 5：状态条可见中间态
    const sub = createAgent({
      ...opts,
      sessionId: sessionId + ':sub',
      mode: 'smart',
      maxTurns: Math.min(opts.maxTurns ?? MAX_TURNS, 8),
      excludeTools: SUBAGENT_EXCLUDE,
      hooks: null,
    });
    const r = await sub.run(goal);
    bus.emit('agent.subagent', { goal, phase: 'complete', ok: r.ok, turns: r.turns, session_id: sessionId + ':sub' });
    return { ok: r.ok, output: r.text, turns: r.turns };
  };

  const toolCtx: ToolCtx = {
    cwd: process.cwd(),
    dataDir: join(process.cwd(), 'data'),
    ask: async (q) => (opts.onApproval ? opts.onApproval('ask_user', { question: q }) : false),
    spawnSubagent: spawnSub,
    // F15：getter 动态取当前轮次信号（loop 每轮重建 abortSignal，工具执行须拿到最新）
    get signal() { return abortSignal?.abortController?.signal; },
  };

  const onApproval = opts.onApproval ?? (async () => true);

  // F7：steer 注入队列（运行中向当前回合注入用户消息）
  const steerQueue: string[] = [];
  const steer = (text: string): boolean => {
    if (!text.trim()) return false;
    steerQueue.push(text.trim());
    return true;
  };

  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    bus.emit('agent.tool', { name, args, phase: 'start' });
    const t0 = Date.now();
    try {
      const tool = tools[name];
      if (!tool) return `未知工具：${name}（可用：${Object.keys(tools).slice(0, 12).join(', ')}）`;
      // F12：权限模型读 tool.danger（单一事实来源）
      const verdict = modeVerdict(mode, name, args, tool.danger);
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
      // F4：危险/外部工具输出统一 untrusted 包裹（提示注入防护）
      const raw = await tool.run(args, toolCtx);
      const out = tool.danger ? wrapDanger(raw) : raw;
      bus.emit('agent.tool', { name, phase: 'complete', ok: true, ms: Date.now() - t0 });
      hooks?.postToolUse(name, out);
      return out;
    } catch (e: any) {
      bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0 });
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
    const callWithAbort = (req: { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] }) => {
      // 修复 F3：abort 信号同时传入 fetch（真中断流式读取）与 race（吞 late rejection）
      const racing = callModel(req, { onToken: (t) => bus.emit('agent.token', { text: t }), signal: abortSignal.abortController.signal });
      racing.catch(() => { /* race 输家静默（abort 后模型 reject 不再 unhandled） */ });
      return Promise.race([
        racing,
        abortSignal.promise.then(() => { throw new Error('aborted'); }),
      ]);
    };
    const msgs: Array<{ role: string; content: string | null; tool_call_id?: string; reasoning_content?: string; thinking_content?: string; reasoning?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }> = [];
    // 项目引导注入（对比轮 5 修复）：AGENTS.md 存在时进系统提示（kimi 运行时注入对齐）
    const agentsMd = loadAgentsMd(process.cwd());
    if (agentsMd) msgs.push({ role: 'system', content: `（项目引导 AGENTS.md）\n${agentsMd}` });
    // 历史进模型（修复 F1）：加载当前会话未归档历史作为上下文前缀——
    // 多轮对话必须让模型看到完整（压缩后）历史，而非仅当前问题 + 3 条召回
    try {
      const history = opts.mem.working(sessionId);
      for (const h of history) {
        if (h.role === 'user' || h.role === 'assistant') {
          msgs.push({ role: h.role, content: h.content });
        }
      }
    } catch { /* 历史加载失败不阻断 */ }
    // 召回注入（黑洞引擎：FTS 命中历史上下文；限定当前会话防串记忆）
    const recalled = await opts.mem.recallHybrid(prompt, { limit: 3, sessionId });
    const recallBlock = recalled.length
      ? `\n[相关历史记忆（本会话）]\n${recalled.map(r => r.content.slice(0, 300)).join('\n---\n')}`
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
      // F7：steer 注入——运行中队列消息并入当前回合上下文
      while (steerQueue.length) {
        const s = steerQueue.shift()!;
        msgs.push({ role: 'user', content: s });
        bus.emit('agent.token', { text: `\n[steer] ${s}\n` });
      }
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
        // 批量工具调用（对比轮 5 修复）：同回合全部 tool_calls 顺序执行，assistant.tool_calls 一次回填
        const batch = res.calls?.length
          ? res.calls.map(c => ({ id: c.id ?? `call_${Date.now().toString(36)}${turns}`, name: c.name, args: c.args ?? {}, reasoning: c.reasoning, reasoningField: c.reasoningField }))
          : [{ id: res.id ?? `call_${Date.now().toString(36)}${turns}`, name: res.name, args: res.args ?? {}, reasoning: res.reasoning, reasoningField: res.reasoningField }];
        const executed: Array<{ id: string; name: string; args: Record<string, any>; out: string; reasoning?: string; reasoningField?: string }> = [];
        let anyFail = false;
        for (const c of batch) {
          if (!tools[c.name]) {
            // 未知工具：跳过该调用（计入阈值防模型空转），其余调用继续执行
            unknownRounds++;
            if (unknownRounds >= MAX_UNKNOWN_TOOL_ROUNDS) {
              bus.emit('agent.error', { message: `连续 ${MAX_UNKNOWN_TOOL_ROUNDS} 轮未知工具，终止` });
              return { ok: false, text: '模型连续调用未知工具，已终止', turns, interrupted };
            }
            executed.push({ id: c.id, name: c.name, args: c.args, out: `工具 ${c.name} 不存在` });
            continue;
          }
          unknownRounds = 0;
          const out = await executeTool(c.name, c.args);
          if (out.includes('失败') || out.includes('异常')) anyFail = true;
          executed.push({ id: c.id, name: c.name, args: c.args, out, reasoning: c.reasoning, reasoningField: c.reasoningField });
          try { opts.mem.append(sessionId, 'tool', `${c.name}: ${out.slice(0, 300)}`); } catch { /* 忽略 */ }
        }
        consecutiveFail = anyFail ? consecutiveFail + 1 : 0;
        if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
          bus.emit('agent.error', { message: `同工具连续失败 ${MAX_CONSECUTIVE_FAIL} 次，终止` });
          return { ok: false, text: '同工具连续失败 5 次，已终止', turns, interrupted };
        }
        const first = executed[0]!;
        msgs.push({
          role: 'assistant',
          content: '',
          ...(first.reasoning ? { [first.reasoningField ?? 'reasoning_content']: first.reasoning } : {}),
          tool_calls: executed.map(e => ({ id: e.id, type: 'function' as const, function: { name: e.name, arguments: JSON.stringify(e.args ?? {}) } })),
        });
        for (const e of executed) {
          msgs.push({ role: 'tool', tool_call_id: e.id, content: e.out });
        }
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

  // loop-goal 模式（Kimi Ralph 同款）：目标驱动自主循环——
  // 模型自主规划/执行/自判完成（输出 [GOAL_DONE] 结束），直到完成或轮次上限；
  // 每轮 loop 独立回合（历史经 working 窗口延续上下文）
  const MAX_GOAL_ROUNDS = 10;
  const GOAL_DONE_MARK = '[GOAL_DONE]';
  async function runWithGoalLoop(prompt: string): Promise<AgentResult> {
    if (mode !== 'goal') return loop(sessionId, prompt);
    const goalPrompt = `${prompt}\n\n（goal 模式：自主规划并持续执行直到目标全部完成。全部完成时回复末尾输出 ${GOAL_DONE_MARK}，未完成则继续执行。每轮都可以调用工具。）`;
    let result = await loop(sessionId, goalPrompt);
    let rounds = 1;
    while (rounds < MAX_GOAL_ROUNDS && !result.interrupted && !result.text.includes(GOAL_DONE_MARK)) {
      rounds++;
      bus.emit('agent.stage', { stage: `goal 循环第 ${rounds}/${MAX_GOAL_ROUNDS} 轮…` });
      result = await loop(sessionId, `（goal 模式第 ${rounds} 轮）继续执行直到目标全部完成，完成后输出 ${GOAL_DONE_MARK}。以上文历史为当前进度。`);
    }
    if (result.text.includes(GOAL_DONE_MARK)) {
      // 转义方括号（正则字符类）——[GOAL_DONE] 必须按字面匹配
      const esc = GOAL_DONE_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result.text = result.text.replace(new RegExp(`\\s*${esc}\\s*$`), '').trim();
    }
    return result;
  }

  return {
    async run(prompt: string): Promise<AgentResult> {
      return runWithGoalLoop(prompt);
    },
    spawnSubagent: spawnSub,
    abort() { aborted = true; abortSignal.abortController.abort(); abortSignal.resolve(); },
    setMode(m: Mode) { mode = m; },
    getMode(): Mode { return mode; },
    // F7：运行中注入消息（busy_input_mode: steer）
    steer(text: string): boolean { return steer(text); },
    // 会话切换：多会话 UI 复用同一 agent 实例（消息经 mem.append 落库到目标会话）
    setSessionId(id: string) { sessionId = id; },
  };
}

function safeJson(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}
