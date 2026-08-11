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
import { modeVerdict, loadPermRules, applyRules, type Mode } from './permissions.js';
import type { HookRunner } from './hooks.js';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { loadProjectRules } from './projectRules.js';

export interface ModelCall { type: 'text'; content: string; reasoning?: string; reasoningField?: string }
export interface ToolCallMsg { type: 'tool_call'; name: string; args: Record<string, any>; id?: string; reasoning?: string; reasoningField?: string; calls?: Array<{ id: string; name: string; args: Record<string, any>; reasoning?: string; reasoningField?: string }> }

export interface AgentOptions {
  db: Db;
  bus: EventBus;
  mem: Memory;
  sessionId: string;
  config: { settings: { apiKeyEnc?: string | null; baseURL?: string; model?: string } };
  callModel?: ((req: { messages: Array<{ role: string; content: string | Array<Record<string, any>> | null }>; tools?: unknown[] }, streamCtx?: { onToken?: (t: string) => void; onReasoning?: (t: string) => void; signal?: AbortSignal }) => Promise<ModelCall | ToolCallMsg>) | null;
  mode?: Mode;
  onApproval?: (tool: string, args: Record<string, any>) => Promise<boolean>;
  /** C6：文字提问回调（clarify 工具）——返回用户文本答案 */
  onClarify?: (question: string, choices?: string[]) => Promise<string>;
  maxTurns?: number;
  /** 生命周期 hooks（本地命令执行）；缺省关闭 */
  hooks?: HookRunner | null;
  /** 附加工具（如 MCP 客户端工具表 mcp__<server>__<tool>） */
  extraTools?: Record<string, import('./tools.js').ToolDef>;
  /** 上下文窗口上限（自动压缩触发阈值基准，默认 64k） */
  maxContextTokens?: number;
  /** 排除的工具名（子代理收窄工具集用） */
  excludeTools?: string[];
  /** P3 安全注入通道：vault=内存保险库；sudoInjection/secretInjection=通道开关（/security 控制，默认关闭） */
  security?: { sudoInjection?: boolean; secretInjection?: boolean; vault?: import('./secrets.js').SecretVault | null };
  /** 敏感输入请求（用户亲手输入）：kind=sudo 返回密码；kind=secret 返回密钥值；不可用返回 null */
  onSecretRequest?: (kind: 'sudo' | 'secret', prompt: string, name?: string) => Promise<string | null>;
  /** 动态内容表（多字段敏感输入）：CLI 弹表单用户逐字段输入；值仅内存；不可用返回 null */
  onFormRequest?: (fields: Array<{ name: string; label?: string; kind: 'text' | 'password' | 'key' }>, prompt?: string) => Promise<Record<string, string> | null>;
  /** 简化人工操作（阶段 C）：smart 模式下工作区内文件编辑自动放行（默认开启） */
  lowRiskAutoApprove?: boolean;
  /** 数据目录（P0-2 审批规则文件 data/permissions.json 读取位置） */
  dataDir?: string;
  /** AI 审批预审（/perm auto-review 开启）：LLM 预审代替人工弹窗，allow/deny/ask */
  autoReview?: { enabled: () => boolean; review: (req: { tool: string; args: string; cwd: string }) => Promise<'allow' | 'ask' | 'deny'> };
  /** 工具延迟加载（P2，默认关）：开启后首轮只注入核心工具 + tool_search，
   *  模型检索到高级工具后动态激活——省工具 schema token（Codex tool_search 自研版） */
  toolLazyLoad?: boolean;
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



/** 可重建的 abort 信号：Promise.race 一次性语义要求每轮新建 promise。
 *  abortController 供真 AbortSignal（fetch/子进程中断）使用。 */
function makeAbortSignal(): { promise: Promise<void>; resolve: () => void; abortController: AbortController } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  const abortController = new AbortController();
  return { promise, resolve, abortController };
}

export function createAgent(opts: AgentOptions) {
  // P1b：tools 可变——插件热重载（updateTools 重建，不重启进程）
  let tools = Object.fromEntries(
    Object.entries({ ...coreTools(), ...(opts.extraTools ?? {}) }).filter(([n]) => !(opts.excludeTools ?? []).includes(n)),
  );
  const bus = opts.bus;
  let sessionId = opts.sessionId; // 可变：setSessionId 热切换（多会话）
  let mode = opts.mode ?? 'smart'; // 可变：/perm 切换经 setMode 热更新

  // 会话 token 预算（Gemini general.budget 对齐）：settings.budgetTokens>0 时，
  // 会话累计用量超预算 → system.notice 告警一次（防刷屏）；0/缺省 = 不设限
  const budgetTokens = Number((opts.config?.settings as any)?.budgetTokens) || 0;

  // 阶段 2（AI 自主触发）：会话首轮自动注入仓库地图 + 技能清单（仅一次）——
  // 模型先看项目结构再动手、自主 skill_load，减少人工 /map 与 /skill list
  let autoInjectDone = false;
  let budgetWarned = false;
  function checkBudget(): void {
    if (!budgetTokens || budgetWarned) return;
    try {
      const row = opts.db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens),0) t FROM usage_stats WHERE session_id=?`).get(sessionId) as { t: number } | undefined;
      const total = row?.t ?? 0;
      if (total > budgetTokens) {
        budgetWarned = true;
        bus.emit('system.notice', { text: `会话 token 预算已达上限（${total}/${budgetTokens}）——建议 /compact 压缩或 /new 开启新会话控制成本` });
      }
    } catch { /* 统计失败静默 */ }
  }

  // C1 修复（中断竞态）：回合级状态——abort() 只操作当前回合（turn 引用），
  // 旧回合在收尾时读取自己的 st 快照，不会被新回合的重置标志污染而"复活"
  let turn: { aborted: boolean; interrupted: boolean; signal: { promise: Promise<void>; resolve: () => void; abortController: AbortController } } | null = null;
  // Hooks（生命周期本地命令）：settings.hooks 热生效——每次触发读当前配置
  const hooks = opts.hooks ?? null;

  // 默认模型调用：OpenAI 兼容真流式（SSE）——token 逐块推送总线（UI 实时显示）
  // 工具调用解析保留 tool_call id（严格格式：assistant.tool_calls + tool.tool_call_id 回填）
  // ── 工具延迟加载（P2）：核心工具常驻 + tool_search 检索激活高级工具 ──
  const CORE_TOOL_NAMES = new Set(['fs_read', 'fs_write', 'fs_edit', 'bash', 'ls', 'grep', 'todo', 'clarify', 'ask_user', 'skill_load', 'tool_search']);
  let activeToolNames: Set<string> | null = null; // null = 延迟加载关闭（全表注入）
  if (opts.toolLazyLoad) {
    activeToolNames = new Set(CORE_TOOL_NAMES);
  }
  // 检索函数：按名称/描述关键词打分（token 分词 + 子串），返回 top-k 工具描述
  function searchTools(query: string, all: Record<string, import('./tools.js').ToolDef>, limit = 5): Array<{ name: string; description: string }> {
    const q = query.toLowerCase();
    const tokens = q.split(/[\s，。、,]+/).filter(Boolean);
    // 中文 bigram 展开（'写入记忆' → '写入','入记','记忆'）——命中任一即得分
    const bigrams = new Set<string>();
    for (const tk of tokens) {
      for (let i = 0; i + 1 < tk.length; i++) bigrams.add(tk.slice(i, i + 2));
    }
    const scored: Array<{ name: string; description: string; score: number }> = [];
    for (const [name, t] of Object.entries(all)) {
      if (activeToolNames?.has(name)) continue; // 已激活不重复
      const desc = String(t.schema?.function?.description ?? '');
      const hay = `${name} ${desc}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 10;
      for (const tk of tokens) if (tk && hay.includes(tk)) score += 3;
      if (name.includes(q)) score += 6;
      for (const bg of bigrams) if (hay.includes(bg)) score += 1; // bigram 弱命中
      if (score > 0) scored.push({ name, description: desc.slice(0, 120), score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // 模型降级链（智能度增强）：429/5xx → 同 provider 备选模型自动降级重试
  // 会话级保持（degradedModel 非空即不再逐轮重试）；/model 手动切换后重置
  let degradedModel: string | null = null;

  const defaultCallModel = async (
    req: { messages: Array<{ role: string; content: string | Array<Record<string, any>> | null }>; tools?: unknown[] },
    streamCtx?: { onToken?: (t: string) => void; onReasoning?: (t: string) => void; signal?: AbortSignal },
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
      const q = (() => { const c = req.messages[req.messages.length - 1]?.content ?? ''; return typeof c === 'string' ? c : ''; })();
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
    let resp = await fetch(httpReq.url, { method: 'POST', headers: httpReq.headers, body: httpReq.body, signal: fetchSignal });
    // 模型降级链：429/5xx 且未降级 → 同 provider 备选模型重试（单 key 语义，/model 可复位）
    if (!resp.ok && (resp.status === 429 || resp.status >= 500) && !degradedModel) {
      const provider = MODEL_CATALOG.find(m => m.modelId === model)?.provider ?? '';
      const fallbacks = MODEL_CATALOG.filter(m => m.provider === provider && m.modelId !== model && !m.capabilities?.imageIn).slice(0, 2);
      for (const fb of fallbacks) {
        bus.emit('system.notice', { text: `模型 ${model} 不可用（HTTP ${resp.status}）——降级到 ${fb.modelId} 重试` });
        const fbReq = buildChatRequest({ baseURL, model: fb.modelId, key, messages: req.messages as any, stream: true, tools: req.tools });
        const r2 = await fetch(fbReq.url, { method: 'POST', headers: fbReq.headers, body: fbReq.body, signal: fetchSignal }).catch(() => null);
        if (r2?.ok) { degradedModel = fb.modelId; resp = r2; break; }
      }
    }
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
    // B2 真实用量统计：OpenAI 兼容流最后一条数据携带 usage（prompt/completion tokens）
    let usageData: { prompt_tokens?: number; completion_tokens?: number } | null = null;

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
        // C2 修复：SSE 错误对象（OpenAI/DeepSeek 流中报错如上下文超限）不得静默吞掉——
        // 识别 j.error / finish_reason=error，抛带消息的 Error 走错误反馈路径
        if (j?.error) {
          const msg = j.error?.message ?? j.error?.code ?? 'SSE 流错误';
          throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300));
        }
        if (j?.usage) usageData = j.usage;
        const delta = j?.choices?.[0]?.delta;
        const finishReason = j?.choices?.[0]?.finish_reason;
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
            // C5 修复：思考分片实时推送（UI reasoning.delta 事件，参考 CLI 流式思考同款）
            streamCtx?.onReasoning?.(v);
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
        // C2：finish_reason=error 且无内容 → 视为错误
        if (finishReason === 'error' && !full) {
          throw new Error('模型流结束于错误状态（无输出）');
        }
      }
    }
    // C2：正常结束但空内容（无 token 无工具调用）→ 错误而非静默空消息
    if (!full && !toolCalls.length) {
      throw new Error('模型返回空响应');
    }

    // B2 真实用量统计：异步写库（失败静默，不阻断对话）
    if (usageData?.prompt_tokens || usageData?.completion_tokens) {
      try {
        opts.db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`)
          .run(sessionId, model, usageData.prompt_tokens ?? 0, usageData.completion_tokens ?? 0, Date.now());
      } catch { /* 统计失败不影响对话 */ }
      // 会话 token 预算（Gemini general.budget 对齐）：settings.budgetTokens>0 时，
      // 会话累计用量（usage_stats 实时 SUM）超预算 → 通知一次（防刷屏），
      // 上下文自动压缩仍按窗口阈值独立触发——预算只做成本告警
      void checkBudget();
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
    // C4 修复：subagent_id 稳定（start/complete 同 id，/agents 面板可正确闭合）
    bus.emit('agent.subagent', { goal, phase: 'start', session_id: sessionId + ':sub', subagent_id: sessionId + ':sub' });
    hooks?.subagentStart(goal);
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
    bus.emit('agent.subagent', { goal, phase: 'complete', ok: r.ok, turns: r.turns, session_id: sessionId + ':sub', subagent_id: sessionId + ':sub' });
    hooks?.subagentStop({ ok: r.ok, output: r.text, turns: r.turns });
    return { ok: r.ok, output: r.text, turns: r.turns };
  };

  // tool_search 工具（延迟加载入口）：检索 + 激活高级工具
  if (opts.toolLazyLoad) {
    tools['tool_search'] = {
      schema: { type: 'function', function: { name: 'tool_search', description: '检索高级工具（按关键词，如 "图片" "网络" "视频"）——命中后该工具立即可用', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
      danger: false,
      async run({ query }, ctx) {
        const hits = searchTools(String(query ?? ''), tools);
        if (!hits.length) return '未找到匹配工具（可用核心工具：' + [...CORE_TOOL_NAMES].filter(n => n !== 'tool_search').join('、') + '）';
        for (const h of hits) activeToolNames?.add(h.name);
        return `已激活 ${hits.length} 个工具（下次调用可用）：\n` + hits.map(h => `- ${h.name}：${h.description}`).join('\n');
      },
    };
  }

  const toolCtx: ToolCtx = {
    cwd: process.cwd(),
    dataDir: join(process.cwd(), 'data'),
    db: opts.db, // cron_create 等需要持久化能力的工具
    ask: async (q) => (opts.onApproval ? opts.onApproval('ask_user', { question: q }) : false),
    clarify: async (q, choices) => (opts.onClarify ? opts.onClarify(q, choices) : ''),
    spawnSubagent: spawnSub,
    // F15：getter 动态取当前轮次信号（每回合独立信号，工具执行须拿到当前回合的）
    get signal() { return turn?.signal.abortController?.signal; },
    // P3 安全注入通道：任一通道开启才暴露 vault（关闭即工具侧不可用）
    secrets: opts.security?.vault && (opts.security.sudoInjection || opts.security.secretInjection)
      ? { vault: opts.security.vault, sudoEnabled: !!opts.security.sudoInjection, secretEnabled: !!opts.security.secretInjection }
      : null,
    requestSecret: opts.onSecretRequest,
    // 动态内容表（credential_form 工具）：经 gateway 弹多字段表单（仅内存）
    requestForm: opts.onFormRequest,
    hookFailure: (name, err) => hooks?.postToolUseFailure(name, err),
  };

  const onApproval = opts.onApproval ?? (async () => true);

  // P0-2 审批规则文件：启动加载 data/permissions.json，工具执行前应用（deny>allow>ask）
  const permRules = loadPermRules(opts.dataDir ?? join(process.cwd(), 'data'));

  // F7：steer 注入队列（运行中向当前回合注入用户消息）
  const steerQueue: string[] = [];
  const steer = (text: string): boolean => {
    if (!text.trim()) return false;
    steerQueue.push(text.trim());
    return true;
  };

  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    // C3 修复：工具调用稳定 id（start/complete 同 id，UI 工具卡可正确闭合）
    const toolId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    bus.emit('agent.tool', { name, args, phase: 'start', toolId });
    const t0 = Date.now();
    try {
      const tool = tools[name];
      if (!tool) return `未知工具：${name}（可用：${Object.keys(tools).slice(0, 12).join(', ')}）`;
      // 工具延迟加载：未激活的高级工具 → 引导检索（不静默失败）
      if (activeToolNames && !activeToolNames.has(name) && name !== 'tool_search') {
        return `工具「${name}」未加载——请先调用 tool_search 检索并激活该工具（参数 query 填关键词）`;
      }
      // F12：权限模型读 tool.danger（单一事实来源）
      // P0-2：持久化规则优先裁决（deny 直接拒绝 / allow 跳过审批 / ask 强制确认）
      const ruleHit = applyRules(name, args, permRules);
      if (ruleHit === 'deny') return `工具被规则拒绝：${name}（/perm rule remove 可移除规则）`;
      const verdict = modeVerdict(mode, name, args, tool.danger);
      if (verdict === 'reject') return `工具被拒绝：权限红线（${name}）`;
      // 简化人工操作（阶段 C）：smart 模式 + 低危文件编辑（工作区内）→ 自动放行，
      // 不再逐次弹审批（acceptEdits 语义）；工作区外/危险操作/plan 模式不受影响
      const lowRiskFile = opts.lowRiskAutoApprove !== false && mode === 'smart'
        && (name === 'fs_write' || name === 'fs_edit')
        && typeof (args as any)?.path === 'string'
        && isPathWithinCwd(String((args as any).path));
      if (ruleHit === 'allow') {
        bus.emit('system.notice', { text: `规则放行：${name}（/perm rule list 查看）` });
      } else if (opts.autoReview?.enabled() && (verdict === 'confirm' || verdict === 'plan')) {
        // AI 审批预审（D 批次）：LLM 预审代替人工弹窗——allow 放行（留痕）/ deny 拒绝 / ask 弹窗
        const verdict2 = await opts.autoReview.review({ tool: name, args: JSON.stringify(args ?? {}).slice(0, 500), cwd: process.cwd() });
        if (verdict2 === 'allow') {
          bus.emit('system.notice', { text: `AI 预审放行：${name}（auto-review）` });
        } else if (verdict2 === 'deny') {
          bus.emit('system.notice', { text: `AI 预审拒绝：${name}（auto-review）` });
          return `工具被 AI 预审拒绝（${name}）`;
        } else {
          const ok = await onApproval(name, args);
          if (!ok) return `用户拒绝执行 ${name}`;
        }
      } else if (ruleHit === 'ask' && (verdict === 'approve' || verdict === 'confirm')) {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
      } else if (verdict === 'confirm' && lowRiskFile) {
        bus.emit('system.notice', { text: `低危操作自动放行：${name}（工作区内文件编辑，${'/perm'} 可关闭）` });
      } else if (verdict === 'confirm' || verdict === 'plan') {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
      }
      // PreToolUse hook：输出 DENY 即真实拦截（权限门之后、执行之前）
      if (hooks) {
        const allowed = await hooks.preToolUse(name, args);
        if (!allowed) {
          bus.emit('agent.tool', { name, phase: 'complete', ok: false, toolId });
          return `工具被 hook 拒绝（${name}）`;
        }
      }
      // F4：危险/外部工具输出统一 untrusted 包裹（提示注入防护）
      const raw = await tool.run(args, toolCtx);
      const out = tool.danger ? wrapDanger(raw) : raw;
      // 敏感操作自动截图留证（计算机视觉存证）：危险工具执行成功后，后台截屏
      // 存 dataDir/captures/ 供审计追溯（无图形环境自动降级静默；不阻断主流程）
      if (tool.danger) {
        void (async () => {
          try {
            const { captureScreen } = await import('./computer/index.js');
            const shot = await captureScreen();
            if (!shot) return;
            const { mkdirSync, writeFileSync } = await import('node:fs');
            const dir = join(opts.dataDir ?? join(process.cwd(), 'data'), 'captures');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `${Date.now().toString(36)}-${name.replace(/[^\w-]/g, '_')}.png`);
            writeFileSync(file, shot.png);
            bus.emit('system.notice', { text: `敏感操作已截图留证 → ${file}` });
          } catch { /* 留证失败静默（无桌面环境等） */ }
        })();
      }
      bus.emit('agent.tool', { name, phase: 'complete', ok: true, ms: Date.now() - t0, toolId });
      hooks?.postToolUse(name, out);
      return out;
    } catch (e: any) {
      bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0, toolId });
      return `工具执行异常：${e?.message?.slice(0, 300) ?? e}`;
    }
  }

  async function loop(sessionId: string, prompt: string, opts2: { subagent?: boolean; images?: Array<{ dataUrl: string; mime: string }> } = {}): Promise<AgentResult> {
    // 多模态注入（P3 图片附加链路）：用户消息构建为 OpenAI parts 数组（text + image_url）——
    // 仅本次 API 调用的内存消息；DB append 仍存纯文本（消息库文本化）
    const imgParts = (opts2.images ?? []).map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } }));
    // C1：每回合独立状态快照——旧回合收尾读自己的 st，不受新回合影响
    const st = { aborted: false, interrupted: false, signal: makeAbortSignal() };
    turn = st;
    // 子代理生命周期事件（UI agentsOverlay / spawnHistoryStore 消费）
    if (opts2.subagent) {
      bus.emit('agent.subagent', { goal: prompt, phase: 'start', session_id: sessionId, subagent_id: sessionId });
    }
    const callWithAbort = (req: { messages: Array<{ role: string; content: string | Array<Record<string, any>> | null }>; tools?: unknown[] }) => {
      // 修复 F3：abort 信号同时传入 fetch（真中断流式读取）与 race（吞 late rejection）
      // C5：onReasoning 实时转发思考分片（UI reasoning.delta）
      const racing = callModel(req, {
        onToken: (t) => bus.emit('agent.token', { text: t }),
        onReasoning: (r) => bus.emit('reasoning.delta', { text: r }),
        signal: st.signal.abortController.signal,
      });
      racing.catch(() => { /* race 输家静默（abort 后模型 reject 不再 unhandled） */ });
      return Promise.race([
        racing,
        st.signal.promise.then(() => { throw new Error('aborted'); }),
      ]);
    };
    const msgs: Array<{ role: string; content: string | Array<Record<string, any>> | null; tool_call_id?: string; reasoning_content?: string; thinking_content?: string; reasoning?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }> = [];
    // 结构化系统提示（智能度基础）：角色/工作准则/模式语义/输出规范/环境
    const { buildSystemPrompt } = await import('./systemPrompt.js');
    const modelName = (opts.config?.settings as any)?.model ?? '';
    const { hasImageIn } = await import('./providers.js');
    msgs.push({ role: 'system', content: buildSystemPrompt({
      mode, cwd: process.cwd(), model: modelName, hasImageIn: hasImageIn(modelName), sessionId,
    }) });
    // 项目规范注入（生态规范文件链）：AGENTS.md/CLAUDE.md/GEMINI.md/.cursorrules 等
    // 首个存在者进系统提示（多工具共存——一套项目规范多 CLI 消费）
    const projectRules = loadProjectRules(process.cwd());
    if (projectRules) msgs.push({ role: 'system', content: `（项目规范 ${projectRules.file}）\n${projectRules.text}` });
    // 阶段 2（AI 自主触发）：会话首轮极轻量注入（仅一次，防 token 浪费）——
    // ① 顶层结构一行（几十字符：模型有方向感，细节按需 repo_map，不挤占上下文）
    // ② 技能名称清单（一行：模型自主 skill_load）
    // ③ autoRepoMap=true 显式开启时，才注入完整仓库地图（≤400 token，默认关闭）
    if (!autoInjectDone) {
      autoInjectDone = true;
      try {
        const { scanProject } = await import('./projectScan.js');
        const profile = scanProject(process.cwd());
        if (profile.structure.length) {
          msgs.push({ role: 'system', content: `（项目顶层结构）${profile.structure.slice(0, 12).join(' / ')}——需要了解符号/文件细节时调用 repo_map 工具` });
        }
      } catch { /* 结构注入失败不影响 */ }
      try {
        const { discoverSkills } = await import('./skills.js');
        const skills = discoverSkills(opts.dataDir ?? join(process.cwd(), 'data'), process.cwd());
        if (skills.length) {
          msgs.push({ role: 'system', content: `（可用技能：${skills.slice(0, 10).map(s => s.name).join('、')}——需要时用 skill_load 加载）` });
        }
      } catch { /* 技能清单注入失败不影响 */ }
      if ((opts.config?.settings as any)?.autoRepoMap === true) {
        try {
          const { buildRepoMap } = await import('./repoMap.js');
          const rm = buildRepoMap(process.cwd(), { budgetTokens: 400 });
          if (rm.files.length) {
            msgs.push({ role: 'system', content: `（自动仓库地图——先看结构再动手，/map 手动刷新）\n${rm.map}` });
          }
        } catch { /* 注入失败不影响对话 */ }
      }
    }
    // 历史进模型（修复 F1）：加载当前会话未归档历史作为上下文前缀——
    // 多轮对话必须让模型看到完整（压缩后）历史，而非仅当前问题 + 3 条召回
    try {
      const history = opts.mem.working(sessionId);
      for (const h of history) {
        if (h.role === 'user' || h.role === 'assistant') {
          msgs.push({ role: h.role, content: h.content });
        }
      }
      // C11 修复（auto-continue）：上回合被打断（历史以 tool 或 user 结尾）→ 注入继续注记，
      // 否则模型把新提问当作全新任务，丢失被打断的上下文
      const lastH = history.at(-1);
      if (lastH && (lastH.role === 'tool' || lastH.role === 'user')) {
        msgs.push({ role: 'system', content: '（上回合任务被打断——请基于以上进度继续完成，而不是重新开始）' });
      }
    } catch { /* 历史加载失败不阻断 */ }
    // 召回注入（黑洞引擎：FTS 命中历史上下文；限定当前会话防串记忆）
    const recalled = await opts.mem.recallHybrid(prompt, { limit: 3, sessionId });
    const recallBlock = recalled.length
      ? `\n[相关历史记忆（本会话）]\n${recalled.map(r => r.content.slice(0, 300)).join('\n---\n')}`
      : '';
    msgs.push({ role: 'user', content: imgParts.length
      ? [{ type: 'text', text: prompt + recallBlock }, ...imgParts]
      : prompt + recallBlock });
    try { opts.mem.append(sessionId, 'user', prompt); } catch { /* 记忆写入失败不阻断对话 */ }
    // 多模态历史回显（P3）：图片摘要异步入历史——后续轮次可回忆"看过什么图"；
    // append 同步先行（摘要 UPDATE 定位最后一条 user 消息不会错位）；无 key 不调用（红线）
    if (imgParts.length) {
      const { attachImageSummary } = await import('./imageHistory.js');
      void attachImageSummary({
        db: opts.db, sessionId,
        images: opts2.images ?? [],
        apiKeyEnc: (opts.config?.settings as any)?.apiKeyEnc ?? null,
      }).catch(() => { /* 摘要失败不影响对话 */ });
    }
    const toolSource = activeToolNames
      ? Object.fromEntries([...activeToolNames].filter(n => tools[n]).map(n => [n, tools[n]!]))
      : tools;
    const toolList = opts2.subagent ? toolsToOpenAI(Object.fromEntries(Object.entries(toolSource).filter(([n]) => !['fs_write', 'fs_edit', 'bash', 'scaffold_build', 'delegate'].includes(n)))) : toolsToOpenAI(toolSource);
    let turns = 0;
    let consecutiveFail = 0;
    let unknownRounds = 0;
    let finalText = '';
    bus.emit('agent.start', { sessionId, prompt });
    hooks?.userPromptSubmit(prompt, sessionId);
    if (turns === 1) hooks?.sessionStart(sessionId);

    try {
    while (turns < (opts.maxTurns ?? MAX_TURNS)) {
      if (st.aborted) { st.interrupted = true; break; }
      turns++;
      // 会话 token 预算（Gemini general.budget 对齐）：每轮开始检查累计用量（不依赖当轮 usage）
      void checkBudget();
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
        // P1-1：preCompact hook 可阻止压缩（输出 BLOCK）
        if (hooks?.preCompact(`auto: ${used}/${ctxLimit}`)) {
          bus.emit('system.notice', { text: '压缩被 hook 阻止（preCompact BLOCK）' });
        } else {
        bus.emit('system.notice', { text: `上下文已达 ${Math.round((used / ctxLimit) * 100)}%（${used} token）——自动压缩…` });
        const condensed = await compactMessages(msgs as any, async (text) => {
          const r = await callWithAbort({
            messages: [
              { role: 'system', content: '你是对话压缩器：把一段对话浓缩为摘要（中文，≤300 字），保留关键信息（结论、决策、未完成任务、重要数据），去掉寒暄与重复。只输出摘要本身。' },
              { role: 'user', content: text },
            ],
            tools: [],
          });
          return r.type === 'text' ? r.content : '';
        });
        msgs.splice(0, msgs.length, ...condensed);
        // DB 联动（深化）：compactSmart 归档 DB 中部消息——摘要复用已生成文本
        // （不重复调 LLM）；recall 全量保留，working 窗口与内存一致收缩
        try {
          const summaryMsg = condensed.find(m => m.role === 'system' && String(m.content ?? '').includes('压缩摘要'));
          const summaryText = summaryMsg ? String(summaryMsg.content) : '';
          if (summaryText) {
            void opts.mem.compactSmart(sessionId, async () => summaryText).catch(() => { /* DB 同步失败不影响对话 */ });
          }
        } catch { /* 忽略 */ }
        const nextTokens = estimateMessagesTokens(msgs);
        bus.emit('system.notice', { text: `自动压缩完成（${used} → ${nextTokens} token）` });
        hooks?.postCompact(used, nextTokens);
        }
      }
      let res: ModelCall | ToolCallMsg;
      try {
        res = await callWithAbort({ messages: msgs, tools: toolList });
      } catch (e: any) {
        if (st.aborted) { st.interrupted = true; break; }
        // 4xx 确定性错误（密钥无效/模型不存在/请求非法等）：不重试，立即反馈——
        // 否则无效 key 会空转 ~6s（3 次退避重试）才显示错误，被误判为「卡死」。
        // 429 限流除外：mapHttpError 语义为稍后重试，保留退避重试。
        if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 429) {
          bus.emit('agent.error', { message: String(e?.message ?? e) });
          return { ok: false, text: `模型调用失败：${e?.message?.slice(0, 200)}`, turns, interrupted: st.interrupted };
        }
        // 瞬时失败：800ms 退避重试（最多 3 次）
        let tried = 0;
        let lastErr = e;
        while (tried < 3) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (tried + 1)));
          try { res = await callWithAbort({ messages: msgs, tools: toolList }); break; }
          catch (e2: any) { if (st.aborted) { st.interrupted = true; break; } lastErr = e2; tried++; }
        }
        if (st.interrupted) break;
        if (tried >= 3) {
          bus.emit('agent.error', { message: String(lastErr?.message ?? lastErr) });
          return { ok: false, text: `模型调用失败：${lastErr?.message?.slice(0, 200)}`, turns, interrupted: st.interrupted };
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
              return { ok: false, text: '模型连续调用未知工具，已终止', turns, interrupted: st.interrupted };
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
          return { ok: false, text: '同工具连续失败 5 次，已终止', turns, interrupted: st.interrupted };
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
    // C8 修复：错误路径也发 agent.end（ok:false）——事件契约对齐参考（错误也完成回合）
    bus.emit('agent.end', { ok: finalText.length > 0, turns });
    hooks?.sessionEnd({ ok: finalText.length > 0, turns });
    return { ok: finalText.length > 0, text: finalText, turns, interrupted: st.interrupted };
    } finally {
      if (turn === st) turn = null; // C1：当前回合结束，释放 turn 引用
      // Stop hook：无论正常结束/中断/提前 return 都触发（不改 agent.end 总线语义）
      hooks?.stop({ ok: finalText.length > 0, turns });
      if (opts2.subagent) {
        bus.emit('agent.subagent', { goal: prompt, phase: 'complete', ok: finalText.length > 0, turns, session_id: sessionId, subagent_id: sessionId });
      }
    }
  }

  // loop-goal 模式（Kimi Ralph 同款）：目标驱动自主循环——
  // 模型自主规划/执行/自判完成（输出 [GOAL_DONE] 结束），直到完成或轮次上限；
  // 每轮 loop 独立回合（历史经 working 窗口延续上下文）
  const MAX_GOAL_ROUNDS = 10;
  const GOAL_DONE_MARK = '[GOAL_DONE]';
  async function runWithGoalLoop(prompt: string, images?: Array<{ dataUrl: string; mime: string }>): Promise<AgentResult> {
    if (mode !== 'goal') return loop(sessionId, prompt, { images });
    const goalPrompt = `${prompt}\n\n（goal 模式：自主规划并持续执行直到目标全部完成。全部完成时回复末尾输出 ${GOAL_DONE_MARK}，未完成则继续执行。每轮都可以调用工具。）`;
    let result = await loop(sessionId, goalPrompt, { images });
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

  // 降级状态按会话隔离：切换会话即复位（避免跨会话错误保持降级模型）
  let degradedForSession = sessionId;
  const resetDegradeIfNeeded = () => { if (degradedForSession !== sessionId) { degradedModel = null; degradedForSession = sessionId; } };

  return {
    async run(prompt: string, opts?: { images?: Array<{ dataUrl: string; mime: string }> }): Promise<AgentResult> {
      resetDegradeIfNeeded();
      return runWithGoalLoop(prompt, opts?.images);
    },
    spawnSubagent: spawnSub,
    // C1：abort 只作用于当前回合（若在跑）；空闲时置位无副作用
    abort() { const t = turn; if (t) { t.aborted = true; t.signal.abortController.abort(); t.signal.resolve(); } },
    setMode(m: Mode) { mode = m; },
    getMode(): Mode { return mode; },
    // F7：运行中注入消息（busy_input_mode: steer）
    steer(text: string): boolean { return steer(text); },
    // P1b：插件热重载——重建工具表（extraTools 合并 + excludeTools 过滤）
    updateTools(extra: Record<string, import('./tools.js').ToolDef>) {
      tools = Object.fromEntries(
        Object.entries({ ...coreTools(), ...extra }).filter(([n]) => !(opts.excludeTools ?? []).includes(n)),
      );
    },
    // 会话切换：多会话 UI 复用同一 agent 实例（消息经 mem.append 落库到目标会话）
    setSessionId(id: string) { sessionId = id; },
    // M4：当前会话读取——命令层（/undo /fork 等）定位真实会话，不再硬编码 'default'
    getSessionId(): string { return sessionId; },
  };
}

// 路径是否在工作目录内（低危自动放行的安全边界）
function isPathWithinCwd(p: string): boolean {
  try {
    const rel = relative(resolve(process.cwd()), resolve(p));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch { return false; }
}

function safeJson(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}
