// src/kernel/agent.ts — L2-4 agent 循环（核心）
// 设计（参考 ReAct 模式 + 事件驱动 harness + turn 控制器思想）：
//   run(prompt) 循环（≤32 轮）：
//     召回注入（黑洞引擎 FTS）→ 调模型（流式/工具）→ 文本流经事件总线
//     → 工具调用：permissions 检查 → 执行（danger 结果 untrusted 包裹）→ 回填
//     → 同工具连续失败 5 次终止 / 未知工具连续 3 轮终止 / 瞬时失败 800ms 退避重试
//     轮次耗尽兜底（系统性闭环）：工具执行完仍无文本 → 无工具强制总结调用收敛答案；
//     仍失败 → 显式失败文案。任何提前返回都发 agent.message + agent.end（UI 只在
//     agent.end 发布最终消息——漏发 = 回合静默、界面无输出）。
//   无 key → 规则脑兜底（诚实回答）
//   spawnSubagent：独立上下文 + 只读工具集
import type { Db } from '../store/db.js';
import { appendAudit } from '../store/db.js';
import type { EventBus } from './events.js';
import type { Memory } from './memory.js';
import { resolveDataDir } from './paths.js';
import { estimateMessagesTokens, compactMessages, contentToText } from './memory.js';
import { coreTools, toolsToOpenAI, wrapDanger, type ToolCtx, type ToolDef } from './tools.js';
import { resolveModelForChat } from './profiles.js';
import { modeVerdict, loadPermRules, applyRules, type Mode } from './permissions.js';
import { isCompletionClaim, GOAL_DONE_MARK } from './completionClaim.js';
import type { HookRunner } from './hooks.js';
import { join, resolve, relative, isAbsolute } from 'node:path';
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
  /** 生命周期 hooks（本地命令执行）；缺省关闭。Partial：子代理可只继承安全钩子（preToolUse） */
  hooks?: Partial<HookRunner> | null;
  /** 附加工具（如 MCP 客户端工具表 mcp__<server>__<tool>） */
  extraTools?: Record<string, import('./tools.js').ToolDef>;
  /** 上下文窗口上限（自动压缩触发阈值基准，默认 64k） */
  maxContextTokens?: number;
  /** 排除的工具名（子代理收窄工具集用） */
  excludeTools?: string[];
  /** P0-2：自定义 agent 指令覆盖（.wxnodus/agents/*.md 定义）——存在时整体替换内置 system prompt */
  systemPromptOverride?: string;
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
  /** AI 自主调用通道（wx_cmd 工具）：执行斜杠指令并返回文本输出（cli 装配 bus.execute 包装） */
  onCommand?: (input: string) => Promise<string>;
  /** C3：agent 工具 runner（生产 11-port pipeline 分层复用）——danger/写类工具经 pipeline 记账执行；
   * 未装配（测试/降级）完全走 legacy（行为不变）。approver 桥由 runner 标记 legacy 已放行，不二次弹窗 */
  agentToolRunner?: {
    handles(name: string): boolean;
    execute(name: string, args: Record<string, any>, toolCtx: ToolCtx): Promise<import('../protocol/results.js').OperationResult<{ output: string }>>;
  };
}

export interface AgentResult {
  ok: boolean;
  text: string;
  turns: number;
  interrupted: boolean;
  /** 完成态细分（KF-023/024）：零验证副作用的完成声明 → 'incomplete'（exit 3）；普通失败/成功不设 */
  status?: 'succeeded' | 'failed' | 'incomplete' | 'cancelled';
}

const MAX_TURNS = 32;

// ── A22：实时状态一句话——工具动词映射（动态短语，UI 状态行展示）──
const TOOL_STAGE_VERBS: Record<string, string> = {
  fs_read: '读取文件', fs_write: '写入文件', fs_edit: '编辑文件', ls: '列出目录',
  grep: '搜索文本', find_files: '查找文件', bash: '执行命令', http_get: '抓取网页',
  http_request: '发送请求', memory_write: '写入记忆', memory_search: '检索记忆',
  scaffold_build: '构建项目', delegate: '派发子代理', ask_user: '询问用户',
  clarify: '请求澄清', todo: '更新任务清单', skill_load: '加载技能', repo_map: '扫描仓库',
  cron_create: '创建定时任务', credential_form: '录入凭据', wx_cmd: '执行指令',
  tool_search: '检索工具', command_search: '检索命令',
};

/** 工具实时状态短语：动词 + 关键参数摘要（path/url/pattern/command/query 等），动态变化。
 *  UI 侧实时任务清单（wxGateway turnTodos）复用同一动词表——一句话状态与清单标签同源。 */
export function briefToolContext(name: string, args: Record<string, any> | undefined): string {
  const verb = TOOL_STAGE_VERBS[name] ?? name;
  const brief = (['path', 'url', 'pattern', 'command', 'query', 'file', 'goal', 'content'] as const)
    .map(k => args?.[k])
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim().length < 60);
  return brief ? `${verb} ${brief.trim()}` : verb;
}
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
  // P1b：tools 可变——插件热重载（updateTools 增量合并，不重启进程、不覆盖先前注册）
  let extraTools = { ...(opts.extraTools ?? {}) };
  // 演示工具隐藏（真实 cmd 实测缺陷：/plugin new 脚手架 example_greet 对「hello」被
  // 廉价模型选中 → 审批面板阻塞会话）。demo:true 标记 + 遗留 example_ 前缀启发式
  // （旧 plugin.json 无标记）一律不进模型工具集；WXNODUS_INCLUDE_DEMO_TOOLS=1 逃生门
  // （plugin-smoke 等演示脚本用）。工具仍在注册表/命令侧可用（人工经插件命令调用）。
  const DEMO_TOOL_RE = /^example_/;
  const includeDemoTools = process.env.WXNODUS_INCLUDE_DEMO_TOOLS === '1';
  let tools = Object.fromEntries(
    Object.entries({ ...coreTools(), ...extraTools })
      .filter(([n]) => !(opts.excludeTools ?? []).includes(n))
      .filter(([n, t]) => includeDemoTools || (!(t as ToolDef).demo && !DEMO_TOOL_RE.test(n))),
  );
  const bus = opts.bus;
  let sessionId = opts.sessionId; // 可变：setSessionId 热切换（多会话）
  let mode = opts.mode ?? 'smart'; // 可变：/perm 切换经 setMode 热更新

  // 会话 token 预算（Gemini general.budget 对齐）：settings.budgetTokens>0 时，
  // 会话累计用量超预算 → system.notice 告警一次（防刷屏）；0/缺省 = 不设限；
  // settings.budgetStop=true → 超出后硬停（后续轮次 finishEarly 显式失败，绝不静默）
  const budgetTokens = Number((opts.config?.settings as any)?.budgetTokens) || 0;
  const budgetStop = (opts.config?.settings as any)?.budgetStop === true;
  // 余额耗尽自动停（余额监控护栏）：/balance auto-stop on 后，网关实测余额 ≤0
  // 写入 settings.balanceEmpty（运行时态，不落盘）→ 后续轮次硬停（显式失败闭环）
  const balanceAutoStop = ((opts.config?.settings as any)?.balanceMonitor as Record<string, any> | undefined)?.autoStop === true;

  // 阶段 2（AI 自主触发）：会话首轮自动注入仓库地图 + 技能清单（仅一次）——
  // 模型先看项目结构再动手、自主 skill_load，减少人工 /map 与 /skill list
  let autoInjectDone = false;
  let budgetWarned = false;
  let budgetExceeded = false;
  // 上下文水位预警标记（会话级一次——75% 阈值提示主动压缩）
  let ctxWarned = false;
  // 剧本录制器（/script record 挂载）：executeTool 每个调用回调（name/args）
  let scriptRecorder: ((name: string, args: Record<string, any>) => void) | null = null;

  // ── 变更即回归（颠覆性衍生）：fs_write/fs_edit 修改文件后，自动重放
  // auto:true 的剧本（防抖合并 + 执行中标志防递归——剧本自身写文件不再触发）
  let regressionTimer: ReturnType<typeof setTimeout> | null = null;
  let regressionRunning = false;
  const AUTO_REGRESSION_DEBOUNCE_MS = 2000;
  function scheduleAutoRegression(): void {
    if (regressionRunning || regressionTimer) return;
    regressionTimer = setTimeout(() => {
      regressionTimer = null;
      void (async () => {
        regressionRunning = true;
        try {
          const { listScripts } = await import('./scripts.js');
          const autos = listScripts(opts.dataDir ?? '').filter(s => s.auto === true);
          if (!autos.length) return;
          const results: string[] = [];
          for (const sc of autos) {
            try {
              const r = await runScriptInternal(sc.steps);
              const failed = r.log.filter(l => l.kind === 'result' && /失败|异常|不存在/.test(l.text.slice(0, 200)));
              results.push(`${r.ok && !failed.length ? '✅' : '❌'} ${sc.name}${failed.length ? `（${failed.length} 个异常输出）` : ''}`);
            } catch {
              results.push(`❌ ${sc.name}（执行异常）`);
            }
          }
          if (results.length) {
            bus.emit('system.notice', { text: `变更即回归：${results.join('  ')}` });
          }
        } catch { /* 回归失败静默（不影响主流程） */ } finally {
          regressionRunning = false;
        }
      })();
    }, AUTO_REGRESSION_DEBOUNCE_MS);
  }
  // 供 executeTool 与 runScript 内部共用（避免外部 runScript 与内部触发互相递归）
  async function runScriptInternal(steps: WxStep[]): Promise<{ ok: boolean; log: WxLogEntry[] }> {
    const log: WxLogEntry[] = [];
    const run = async (list: WxStep[], siBase: number, depth: number): Promise<number> => {
      let lastOut = '';
      let si = siBase;
      for (const step of list) {
        if ('loop' in step) {
          const { items, as, do: body } = step.loop;
          log.push({ kind: 'loop', step: si, text: `循环 ${items.length} 项` });
          for (const item of items) {
            si = await run(substituteVars(body, as ?? 'item', item), si, depth + 1);
          }
          continue;
        }
        if ('if' in step) {
          const hit = lastOut.includes(step.if.outputContains);
          log.push({ kind: 'if', step: si, text: `条件「${step.if.outputContains.slice(0, 30)}」${hit ? '成立' : '不成立'}` });
          si = await run(hit ? step.if.then : (step.if.else ?? []), si, depth + 1);
          continue;
        }
        if ('parallel' in step) {
          log.push({ kind: 'parallel', step: si, text: `并行 ${step.parallel.length} 个分支` });
          await Promise.all(step.parallel.map(async (branch) => { await run([branch], si, depth + 1); }));
          si++;
          continue;
        }
        if ('task' in step) {
          log.push({ kind: 'task', step: si, text: `子代理：${step.task.goal.slice(0, 60)}` });
          const r = await spawnSub(step.task.goal);
          log.push({ kind: 'result', step: si, name: 'delegate', text: r.output });
          lastOut = r.output;
          si++;
          continue;
        }
        if (step.prompt.trim()) {
          try { opts.mem.append(sessionId, 'user', step.prompt); } catch { /* 忽略 */ }
          log.push({ kind: 'prompt', step: si, text: step.prompt });
        }
        for (const tc of step.tools) {
          log.push({ kind: 'tool', step: si, name: tc.name, text: `${tc.name} ${JSON.stringify(tc.args ?? {}).slice(0, 120)}` });
          const out = await executeTool(tc.name, tc.args ?? {});
          log.push({ kind: 'result', step: si, name: tc.name, text: out });
          lastOut = out;
          try { opts.mem.append(sessionId, 'tool', `${tc.name}: ${out.slice(0, 300)}`); } catch { /* 忽略 */ }
        }
        si++;
      }
      return si;
    };
    try {
      await run(steps, 0, 0);
      return { ok: true, log };
    } catch {
      return { ok: false, log };
    }
  }

  function checkBudget(): void {
    if (!budgetTokens || budgetWarned) return;
    try {
      const row = opts.db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens),0) t FROM usage_stats WHERE session_id=?`).get(sessionId) as { t: number } | undefined;
      const total = row?.t ?? 0;
      if (total > budgetTokens) {
        budgetWarned = true;
        budgetExceeded = true;
        bus.emit('system.notice', {
          text: budgetStop
            ? `会话 token 预算已达上限（${total}/${budgetTokens}）——已硬停（settings.budgetStop=true）；/compact 压缩或 /new 新会话后继续`
            : `会话 token 预算已达上限（${total}/${budgetTokens}）——建议 /compact 压缩或 /new 开启新会话控制成本`,
        });
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
  const CORE_TOOL_NAMES = new Set(['fs_read', 'fs_write', 'fs_edit', 'bash', 'ls', 'grep', 'todo', 'clarify', 'ask_user', 'skill_load', 'tool_search', 'command_search']);
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

  const defaultCallModel = async (
    req: { messages: Array<{ role: string; content: string | Array<Record<string, any>> | null }>; tools?: unknown[] },
    streamCtx?: { onToken?: (t: string) => void; onReasoning?: (t: string) => void; signal?: AbortSignal },
  ): Promise<ModelCall | ToolCallMsg> => {
    const s = opts.config.settings;
    const { resolveApiKey } = await import('./providers.js');
    const keyRes = resolveApiKey(s);

    // enc 存在但解密失败（机器指纹变化/数据损坏）或密钥归属与当前模型 provider 不符——
    // 明确提示修复路径，而不是误导性的「未配置」或对端 401
    if (keyRes.source === 'enc' && !keyRes.key) {
      return { type: 'text', content: keyRes.error === 'provider-mismatch'
        ? (keyRes.hint ?? '密钥与当前模型 provider 不符——/key set <密钥> 重配或 /model 切换')
        : '密钥无法解密（机器环境变化或数据损坏？）——请用 /key set <密钥> 重新配置。' };
    }

    // KF-001：离线 token 包预检——无 key 但 offline: 模型已就绪 → 走本地 LLM 通道
    // （离线优先：数据不出机、模型可不出机），绝不输出密钥配置引导。
    // 未就绪 → 明确引导离线下载（同样是事实，不是 /key set 误导）
    if (!keyRes.key && String(s.model ?? '').startsWith('offline:')) {
      const { isOfflineModelReady } = await import('./offlineModel.js');
      if (isOfflineModelReady(s.model)) {
        const { callLlmStream } = await import('./llmStream.js');
        const r = await callLlmStream({
          baseURL: '', model: s.model!, key: '',
          messages: req.messages as any,
          tools: undefined,
          signal: streamCtx?.signal,
          onToken: streamCtx?.onToken,
          onReasoning: streamCtx?.onReasoning,
        });
        if (!r.ok) return { type: 'text', content: r.error };
        return { type: 'text', content: r.content };
      }
      return {
        type: 'text',
        content: '离线模型未下载——请用 /offline pack download 预下载后断网可用（或 /key set 配置云端密钥）。',
      };
    }

    if (!keyRes.key) {
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

    const key = keyRes.key;

    const { resolveDefaultBaseURL } = await import('./defaults.js');
    // 有 key 即视为已配置：model/baseURL 缺失时用默认，不降级规则脑
    const baseURL = resolveDefaultBaseURL(s);
    // 根因修复：模型名校验放开——任意非空模型名（含中转站自定义名）直接可用；
    // 仅空/缺失时回退档案默认（resolveModelForChat 单一事实源）
    const model = resolveModelForChat(s);
    // 架构 P2：LLM 流式调用服务化（llmStream.ts）——SSE 解析/降级链/用量提取
    // 已抽离；agent 循环只消费结构化结果
    const { callLlmStream } = await import('./llmStream.js');
    const r = await callLlmStream({
      baseURL, model, key,
      messages: req.messages as any,
      tools: req.tools,
      signal: streamCtx?.signal,
      onToken: streamCtx?.onToken,
      onReasoning: streamCtx?.onReasoning,
      onDegrade: (from, to, status) => bus.emit('system.notice', { text: `模型 ${from} 不可用（HTTP ${status}）——降级到 ${to} 重试` }),
    });
    if (!r.ok) {
      const err = new Error(r.error) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    // B2 真实用量统计：异步写库（失败静默，不阻断对话）——model 用实际调用模型（降级后）
    if (r.usage && (r.usage.promptTokens || r.usage.completionTokens)) {
      try {
        opts.db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`)
          .run(sessionId, r.model, r.usage.promptTokens, r.usage.completionTokens, Date.now());
      } catch { /* 统计失败不影响对话 */ }
      // 会话 token 预算（Gemini general.budget 对齐）：settings.budgetTokens>0 时，
      // 会话累计用量（usage_stats 实时 SUM）超预算 → 通知一次（防刷屏），
      // 上下文自动压缩仍按窗口阈值独立触发——预算只做成本告警
      void checkBudget();
    }

    // 批量 tool_calls 全量返回（修复对比轮 5 缺口：同回合多工具调用不得丢弃——
    // OpenAI 流式按 index 累积全部 tool_calls，模型一次可并行请求多个工具）
    if (r.toolCalls.length) {
      const calls = r.toolCalls.map(tc => ({
        id: tc.id || `call_${Date.now().toString(36)}_${r.toolCalls.indexOf(tc)}`,
        name: tc.name,
        args: safeJson(tc.arguments),
        reasoning: r.reasoning,
        reasoningField: r.reasoningField,
      }));
      const first = calls[0]!;
      return { type: 'tool_call', id: first.id, name: first.name, args: first.args, reasoning: first.reasoning, reasoningField: first.reasoningField, calls };
    }
    return { type: 'text', content: r.content, reasoning: r.reasoning, reasoningField: r.reasoningField };
  };
  const callModel = opts.callModel ?? defaultCallModel;

  // 子代理（F9 修复）：独立 agent 实例（独立 abort 状态）+ 深度限制 + 收窄工具集
  // 工具集排除：写文件/执行/委派/记忆写入/外联/提问（只读探索）+ 全部 danger 工具——
  // 审查修复：extraTools（MCP/插件）此前不在名单内，MCP 默认 danger:false 却在 smart 下
  // 无确认执行任意副作用（与 delegate「只读工具集」描述不符）；现按 danger 标志动态剔除
  const SUBAGENT_EXCLUDE = ['fs_write', 'fs_edit', 'bash', 'scaffold_build', 'delegate', 'memory_write', 'http_get', 'ask_user'];
  const MAX_SUBAGENT_DEPTH = 3;
  // A24 第四类修复：委派暂停真实生效（delegation.pause → setDelegationPaused）——
  // 暂停后 delegate 工具/任务系统的新委派被拒绝（诚实返回原因，而非假装执行）
  let delegationPaused = false;
  const spawnSub = async (goal: string, depth = 1, def?: { systemPromptOverride?: string; mode?: Mode; tools?: string[] }): Promise<{ ok: boolean; output: string; turns: number }> => {
    if (depth > MAX_SUBAGENT_DEPTH) {
      return { ok: false, output: `子代理深度超限（${MAX_SUBAGENT_DEPTH} 层）——请拆分子任务`, turns: 0 };
    }
    if (delegationPaused) {
      return { ok: false, output: '委派已暂停（delegation.pause）——用 /delegate resume 或 子代理面板恢复后再派发', turns: 0 };
    }
    // 子代理生命周期事件（独立实例，手动发事件保持 UI 可见）
    // C4 修复：subagent_id 稳定（start/complete 同 id，/agents 面板可正确闭合）
    bus.emit('agent.subagent', { goal, phase: 'start', session_id: sessionId + ':sub', subagent_id: sessionId + ':sub' });
    hooks?.subagentStart?.(goal);
    bus.emit('agent.stage', { stage: `子代理执行中（深度 ${depth}）…` }); // 对比轮 5：状态条可见中间态
    const sub = createAgent({
      ...opts,
      sessionId: sessionId + ':sub',
      maxTurns: Math.min(opts.maxTurns ?? MAX_TURNS, 8),
      // P0-2：自定义 agent 定义生效——mode/指令覆盖/工具白名单（缺省保持只读子代理）
      // 审查修复：mode 继承父会话当前模式（/perm 切换后热生效）——此前恒 'smart'，
      // manual（全量确认）父会话委派后子代理 non-danger 工具自动放行，确认语义被静默降级
      mode: def?.mode ?? mode,
      systemPromptOverride: def?.systemPromptOverride,
      excludeTools: def?.tools
        ? [...new Set([...CORE_TOOL_NAMES, ...Object.keys(tools)])].filter(n => !def.tools!.includes(n))
        : [...new Set([...SUBAGENT_EXCLUDE, ...Object.entries(tools).filter(([, t]) => t.danger).map(([n]) => n)])],
      // 审查修复：保留 preToolUse 安全钩子（DENY 拦截）——此前 hooks:null 使子代理
      // 工具调用绕过用户配置的安全钩子；sessionStart 等主会话钩子仍不继承（子代理不触发）
      hooks: hooks ? { preToolUse: hooks.preToolUse } : null,
    });
    // 白名单声明的工具在懒加载模式下也要激活（否则 schema 不可见）
    if (def?.tools && activeToolNames) {
      for (const t of def.tools) activeToolNames.add(t);
    }
    const r = await sub.run(goal);
    bus.emit('agent.subagent', { goal, phase: 'complete', ok: r.ok, turns: r.turns, session_id: sessionId + ':sub', subagent_id: sessionId + ':sub' });
    hooks?.subagentStop?.({ ok: r.ok, output: r.text, turns: r.turns });
    return { ok: r.ok, output: r.text, turns: r.turns };
  };

  // tool_search 工具（延迟加载入口）：检索 + 激活高级工具
  if (opts.toolLazyLoad) {
    tools['tool_search'] = {
      schema: { type: 'function', function: { name: 'tool_search', description: '检索高级工具（按关键词，如 "图片" "网络" "视频"）——命中后该工具立即可用', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
      danger: false,
      async run({ query }) {
        const hits = searchTools(String(query ?? ''), tools);
        if (!hits.length) return '未找到匹配工具（可用核心工具：' + [...CORE_TOOL_NAMES].filter(n => n !== 'tool_search').join('、') + '）';
        for (const h of hits) activeToolNames?.add(h.name);
        return `已激活 ${hits.length} 个工具（下次调用可用）：\n` + hits.map(h => `- ${h.name}：${h.description}`).join('\n');
      },
    };
  }

  // A24：运行时工作目录（目录选择器 /cwd 切换）——工具 ctx.cwd 动态读取；
  // dataDir 保持启动值（会话数据与记忆不随目录迁移——切换只影响文件/命令操作）
  let ctxCwd = process.cwd();

  const toolCtx: ToolCtx = {
    // getter：setCwd 后工具侧实时跟随（值快照会滞留旧目录）
    get cwd() { return ctxCwd; },
    // W3 Memory：可信 sessionId（agent 内部状态，绝不经工具参数伪造——memory_* 工具的 scope 来源）
    get sessionId() { return sessionId; },
    dataDir: resolveDataDir(process.cwd()), // 开放兼容：WXNODUS_DATA_DIR 覆盖数据目录
    db: opts.db, // cron_create 等需要持久化能力的工具
    bus: opts.bus, // notify 通知工具（system.notice 事件）
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
    // AI 自主调用通道（wx_cmd 工具）：执行斜杠指令（cli 装配 bus.execute 包装）
    runCommand: opts.onCommand,
    hookFailure: (name, err) => hooks?.postToolUseFailure?.(name, err),
    // 开放通道 settings（computer_observe 视觉等）：agent 配置直读
    getSettings: () => (opts.config?.settings as Record<string, any> | undefined) ?? undefined,
  };

  // KF-010：默认审批 fail-closed——未装配 onApproval 时一律拒绝（绝不静默放行副作用）
  const onApproval = opts.onApproval ?? (async () => false);

  // P0-2 审批规则文件：启动加载 data/permissions.json，工具执行前应用（deny>allow>ask）
  const permRules = loadPermRules(opts.dataDir ?? resolveDataDir(process.cwd()));

  // F7：steer 注入队列（运行中向当前回合注入用户消息）
  const steerQueue: string[] = [];
  const steer = (text: string): boolean => {
    if (!text.trim()) return false;
    steerQueue.push(text.trim());
    return true;
  };

  // KF-023/024：单次工具调用的确定性结局（loop 据此累计 verifiedEffects——成功侧记 verified，
  // 拒绝/参数错/未知工具记 other，异常记 failed）；字符串启发式（「失败」/「异常」）仍用于模型回填
  let lastToolOutcome: 'verified' | 'failed' | 'other' = 'other';

  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    lastToolOutcome = 'other';
    // C3 修复：工具调用稳定 id（start/complete 同 id，UI 工具卡可正确闭合）
    const toolId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // A25：事件带 session_id 标记（子代理会话为 <主>:sub 后缀——gateway 据此
    // 分流为 subagent.tool 富事件；此前子代理工具事件混入主面板或直接丢失）
    bus.emit('agent.tool', { name, args, phase: 'start', toolId, session_id: sessionId });
    // 架构 P3：工具调用入事件流（start）
    try {
      const { appendSessionEvent } = await import('./sessionStream.js');
      appendSessionEvent(opts.dataDir ?? resolveDataDir(process.cwd()), sessionId, { type: 'tool', name, phase: 'start', ts: Date.now() });
    } catch { /* 静默 */ }
    // A22：实时状态一句话——正在做什么（基于工具名/参数动态生成，UI 状态行显示）
    const ctxBrief = briefToolContext(name, args);
    bus.emit('agent.stage', { stage: `正在${ctxBrief}` });
    // 剧本录制钩子：/script record 期间每个工具调用进当前 step（跳过 AI 决策的确定性重放源）
    scriptRecorder?.(name, args);
    const t0 = Date.now();
    // A21：审计落库（哈希链——工具裁决/执行/红线全留痕；审计表未就绪静默）
    const auditTool = (event: string, payload: Record<string, unknown>) => {
      try {
        appendAudit(opts.db, event, payload);
      } catch { /* 审计表未就绪时静默 */ }
    };
    try {
      const tool = tools[name];
      if (!tool) return `未知工具：${name}（可用：${Object.keys(tools).slice(0, 12).join(', ')}）`;
      // 工具延迟加载：未激活的高级工具 → 引导检索（不静默失败）
      if (activeToolNames && !activeToolNames.has(name) && name !== 'tool_search') {
        return `工具「${name}」未加载——请先调用 tool_search 检索并激活该工具（参数 query 填关键词）`;
      }
      // 架构深度（OpenCode/AI SDK 对齐）：工具参数 schema 校验中介层——
      // 模型传错参数（缺必填/类型错）在执行前被拒并给出修正提示（此前靠工具内部防御）
      const { validateToolArgs } = await import('./toolArgs.js');
      const argErr = validateToolArgs(name, args, tool);
      if (argErr) {
        bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: 0, toolId, session_id: sessionId });
        auditTool('tool.args-invalid', { tool: name, error: argErr, args: JSON.stringify(args ?? {}).slice(0, 200) });
        return `工具参数错误：${argErr}（请修正后重试）`;
      }
      // F12：权限模型读 tool.danger（单一事实来源）
      // P0-2：持久化规则优先裁决（deny 直接拒绝 / allow 跳过审批 / ask 强制确认）
      // 深度：applyRules 支持 priority/modes/commandPrefix/denyMessage（Gemini policy 对齐）
      const ruleHit = applyRules(name, args, permRules, mode);
      if (ruleHit?.decision === 'deny') {
        auditTool('tool.denied', { tool: name, rule: 'deny', reason: ruleHit.rule.reason ?? '' });
        return `工具被规则拒绝：${name}${ruleHit.rule.denyMessage ? `——${ruleHit.rule.denyMessage}` : ''}（/perm rule remove 可移除规则）`;
      }
      // AI 自主调用通道（wx_cmd）分级裁决：safe 直执行 / confirm 走模式确认链 /
      //   danger 强制人工确认（跳过 autoReview——高危不可 AI 预审放行）/ redline 直接拒绝
      let verdict: import('./permissions.js').Verdict;
      let cmdForceManual = false;
      let cmdLevel: string | undefined;
      if (name === 'wx_cmd') {
        const { classifyCommand } = await import('./commandLevels.js');
        cmdLevel = classifyCommand(String(args?.command ?? ''));
        if (cmdLevel === 'redline') {
          auditTool('tool.redline', { tool: 'wx_cmd', command: String(args?.command ?? '').slice(0, 120) });
          bus.emit('agent.tool', { name, phase: 'complete', ok: false, toolId, session_id: sessionId });
          return `命令被 AI 通道拒绝：${String(args?.command ?? '').slice(0, 80)}（涉及权限/密钥/安全/退出——请用户手动执行）`;
        }
        if (cmdLevel === 'safe') {
          verdict = 'approve';
        } else if (cmdLevel === 'danger') {
          verdict = 'confirm';
          cmdForceManual = true;
        } else {
          // confirm 级：走模式语义（smart/manual/auto/goal→确认、plan→计划审批、yolo→放行）
          verdict = modeVerdict(mode, name, args, tool.danger);
        }
      } else {
        verdict = modeVerdict(mode, name, args, tool.danger);
      }
      // A21：权限裁决留痕（工具/裁决/命令级别/参数摘要）
      auditTool('tool.verdict', {
        tool: name,
        verdict,
        level: cmdLevel,
        args: JSON.stringify(args ?? {}).slice(0, 200),
      });
      if (verdict === 'reject') return `工具被拒绝：权限红线（${name}）`;
      // 简化人工操作（阶段 C）：smart 模式 + 低危文件编辑（工作区内）→ 自动放行，
      // 不再逐次弹审批（acceptEdits 语义）；工作区外/危险操作/plan 模式不受影响
      const lowRiskFile = opts.lowRiskAutoApprove !== false && mode === 'smart'
        && (name === 'fs_write' || name === 'fs_edit')
        && typeof (args as any)?.path === 'string'
        && isPathWithinCwd(String((args as any).path));
      if (ruleHit?.decision === 'allow') {
        bus.emit('system.notice', { text: `规则放行：${name}（/perm rule list 查看）` });
      } else if (opts.autoReview?.enabled() && !cmdForceManual && (verdict === 'confirm' || verdict === 'plan')) {
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
      } else if (ruleHit?.decision === 'ask' && (verdict === 'approve' || verdict === 'confirm')) {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
      } else if (verdict === 'confirm' && lowRiskFile) {
        bus.emit('system.notice', { text: `低危操作自动放行：${name}（工作区内文件编辑，${'/perm'} 可关闭）` });
      } else if (verdict === 'confirm' || verdict === 'plan') {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
      }
      // PreToolUse hook：输出 DENY 即真实拦截（权限门之后、执行之前）
      // 审查修复：Partial hooks 下 preToolUse 可能未配置——undefined 视为放行（allowed===false 才拦）
      if (hooks) {
        const allowed = await hooks.preToolUse?.(name, args);
        if (allowed === false) {
          bus.emit('agent.tool', { name, phase: 'complete', ok: false, toolId, session_id: sessionId });
          return `工具被 hook 拒绝（${name}）`;
        }
      }
      // F4：危险/外部工具输出统一 untrusted 包裹（提示注入防护）
      // C3：runner 已装配且覆盖该工具 → 经生产 pipeline 真实执行（PDP 复核/grant/budget/journal/evidence/postcondition）；
      // 失败（预算超限/策略拒/pipeline 异常）以「工具执行失败（code）」回填（保住 5 连败终止语义）
      const runner = opts.agentToolRunner;
      let raw: string;
      if (runner?.handles(name)) {
        const pres = await runner.execute(name, args, toolCtx);
        if (!pres.ok) {
          bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0, toolId, session_id: sessionId });
          auditTool('tool.executed', { tool: name, ok: false, ms: Date.now() - t0, error: pres.error?.code, pipeline: true });
          lastToolOutcome = 'failed';
          return `工具执行失败（${pres.error?.code ?? 'TOOL_EXECUTE_FAILED'}）：${pres.error?.message ?? ''}`;
        }
        raw = pres.value.output;
      } else {
        raw = await tool.run(args, toolCtx);
      }
      // P0-2：vault 值输出脱敏——工具输出回填模型前，按内存敏感值精确替换（最后防线）
      const v = toolCtx.secrets?.vault;
      const vaultValues = v ? v.secretNames().map(n => v.getSecret(n)).filter((x): x is string => !!x) : [];
      const safe = vaultValues.length ? (await import('./redact.js')).redactVaultValues(raw, vaultValues) : raw;
      const out = tool.danger ? wrapDanger(safe) : safe;
      // 敏感操作自动截图留证（计算机视觉存证）：危险工具执行成功后，后台截屏
      // 存 dataDir/captures/ 供审计追溯（无图形环境自动降级静默；不阻断主流程）
      if (tool.danger) {
        void (async () => {
          try {
            const { captureScreen } = await import('./computer/index.js');
            const shot = await captureScreen();
            if (!shot) return;
            const { mkdirSync, writeFileSync } = await import('node:fs');
            const dir = join(opts.dataDir ?? resolveDataDir(process.cwd()), 'captures');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `${Date.now().toString(36)}-${name.replace(/[^\w-]/g, '_')}.png`);
            writeFileSync(file, shot.png);
            bus.emit('system.notice', { text: `敏感操作已截图留证 → ${file}` });
          } catch { /* 留证失败静默（无桌面环境等） */ }
        })();
      }
      bus.emit('agent.tool', { name, phase: 'complete', ok: true, ms: Date.now() - t0, toolId, session_id: sessionId });
      hooks?.postToolUse?.(name, out);
      // A21：工具执行结果留痕（耗时/成败）
      auditTool('tool.executed', { tool: name, ok: true, ms: Date.now() - t0 });
      // 架构 P3：工具完成入事件流
      try {
        const { appendSessionEvent } = await import('./sessionStream.js');
        appendSessionEvent(opts.dataDir ?? resolveDataDir(process.cwd()), sessionId, { type: 'tool', name, phase: 'complete', ok: true, ms: Date.now() - t0, ts: Date.now() });
      } catch { /* 静默 */ }
      // 变更即回归：文件被真实修改后调度 auto 剧本重放（防抖合并连续改动；
      // 回归重放期间的 fs_write 由 regressionRunning 守卫拦截，不会自我触发）
      if (name === 'fs_write' || name === 'fs_edit') scheduleAutoRegression();
      // 深度（Aider auto_commit 对齐）：git 仓库内文件编辑后自动提交本次文件
      // （commit 消息标注 [wxnodus]；settings.autoGitCommit=false 可关；失败静默不阻断）
      // 审查修复：运算符优先级——本意 (fs_write||fs_edit) && !被拒绝；&& 优先于 || 导致
      // fs_write 被规则拒绝时仍触发自动提交（把未发生的改动提交进 git 历史）
      if ((name === 'fs_write' || name === 'fs_edit') && !out.startsWith('工具被规则拒绝')) {
        try { await maybeAutoGitCommit(name, args, ctxCwd); } catch { /* 静默 */ }
      }
      lastToolOutcome = 'verified';
      return out;
    } catch (e: any) {
      lastToolOutcome = 'failed';
      bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0, toolId, session_id: sessionId });
      auditTool('tool.executed', { tool: name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 120) });
      return `工具执行异常：${e?.message?.slice(0, 300) ?? e}`;
    }
  }

  // 深度（Aider auto_commit 对齐）：git 仓库内 fs 编辑后自动提交——仅提交本次文件，
  // 避免误提交用户其他改动；无 git/非仓库/失败一律静默（编辑结果不受影响）
  async function maybeAutoGitCommit(toolName: string, args: Record<string, any>, cwd: string): Promise<void> {
    const settings = opts.config?.settings as Record<string, any> | undefined;
    if (settings?.autoGitCommit === false) return; // 默认开启（Aider 语义），显式 false 关闭
    const p = String(args?.path ?? '').trim();
    if (!p) return;
    const { execFileSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const abs = resolve(cwd, p);
    const workDir = resolve(cwd);
    try {
      // 非 git 仓库直接跳过（快速失败）
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workDir, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 5000 });
    } catch { return; }
    try {
      const rel = abs.startsWith(workDir) ? abs.slice(workDir.length).replace(/^[\\/]/, '') : abs;
      execFileSync('git', ['add', '--', rel], { cwd: workDir, stdio: 'pipe', windowsHide: true, timeout: 5000 });
      execFileSync('git', ['commit', '-m', `[wxnodus] ${toolName === 'fs_write' ? '写入' : '编辑'} ${rel.slice(0, 60)}`, '--no-verify'], { cwd: workDir, stdio: 'pipe', windowsHide: true, timeout: 10000 });
      bus.emit('system.notice', { text: `已自动提交（git）：${rel.slice(0, 60)}——/undo 或 git log 可审查` });
    } catch { /* 提交失败（无改动/冲突）静默 */ }
  }

  /** KF-023/024：单次 run 的已验证工具副作用计数（跨 goal 轮次累计） */
  interface RunState { verifiedEffects: number }

  async function loop(sessionId: string, prompt: string, opts2: { subagent?: boolean; images?: Array<{ dataUrl: string; mime: string }>; runState?: RunState } = {}): Promise<AgentResult> {
    const rs = opts2.runState ?? { verifiedEffects: 0 };
    // 架构 P3：会话事件流（可重放/审计）——用户消息入流
    try {
      const { appendSessionEvent } = await import('./sessionStream.js');
      appendSessionEvent(opts.dataDir ?? resolveDataDir(process.cwd()), sessionId, { type: 'user', content: prompt.slice(0, 500), ts: Date.now() });
    } catch { /* 静默 */ }
    // 多模态注入（P3 图片附加链路）：用户消息构建为 OpenAI parts 数组（text + image_url）——
    // 仅本次 API 调用的内存消息；DB append 仍存纯文本（消息库文本化）。
    // 规避（ZCode deepseek-v4-pro「unknown variant image_url」同款 400 的防御纵深）：
    // 能力门在 agent 环内执行——视觉模型直接注入 parts；文本模型先用视觉通道识别为文本
    // （GLM 默认/自定义 vision 端点/本地 VLM/Windows OCR），有图才调用识别、无图零视觉调用；
    // 识别失败/无 key 诚实丢弃（绝不把 image_url 发给纯文本模型），失败落审计。
    const modelName = (opts.config?.settings as any)?.model ?? '';
    const { hasImageIn, imageStrategy } = await import('./providers.js');
    let imgParts: Array<Record<string, any>> = [];
    let imageDesc = '';
    if (opts2.images?.length) {
      const strategy = imageStrategy(modelName, opts2.images.length);
      if (strategy.kind === 'inject') {
        imgParts = opts2.images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } }));
      } else {
        try {
          const { describeImage } = await import('./vision.js');
          const settings = opts.config?.settings;
          const first = opts2.images[0]!;
          const desc = await describeImage(
            first.dataUrl,
            (settings as any)?.apiKeyEnc ?? null,
            '用不超过 150 字的中文描述这张图片的内容（画面主体、文字、布局）。只输出描述。',
            // 自动降级路径跳过 Windows OCR（聊天回合内不 spawn PowerShell——显式 /vision 仍保留 OCR 兜底）
            { ...(settings as any), visionOcr: false },
          );
          if (desc?.trim()) {
            imageDesc = desc.trim();
            if (opts2.images.length > 1) imageDesc += `（另附 ${opts2.images.length - 1} 张图片未逐张识别）`;
          }
        } catch { /* 识别异常按无图处理 */ }
        if (imageDesc) {
          bus.emit('system.notice', { text: `当前模型不支持图像输入——已用视觉通道识别图片内容注入` });
          try { appendAudit(opts.db, 'agent.image.described', { model: modelName, count: opts2.images.length }); } catch { /* 审计表未就绪静默 */ }
        } else {
          bus.emit('system.notice', { text: `当前模型不支持图像输入且视觉识别失败——已忽略附加图片（不发送 image_url 防 400）` });
          try { appendAudit(opts.db, 'agent.image.dropped', { model: modelName, count: opts2.images.length }); } catch { /* 审计表未就绪静默 */ }
        }
      }
    }
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
        // A25：reasoning 带 session_id 标记（子代理 → gateway 分流 subagent.thinking）
        onReasoning: (r) => bus.emit('reasoning.delta', { text: r, session_id: sessionId }),
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
    // P0-2：自定义 agent（.wxnodus/agents/*.md）经 systemPromptOverride 整体替换
    const { buildSystemPrompt } = await import('./systemPrompt.js');
    msgs.push({ role: 'system', content: opts.systemPromptOverride ?? buildSystemPrompt({
      mode, cwd: process.cwd(), model: modelName, hasImageIn: hasImageIn(modelName), sessionId,
      // 开放兼容：/lang 设置生效（输出语言）+ dataDir 支持外部 prompts/system.md 覆盖
      lang: (opts.config?.settings as any)?.lang,
      dataDir: opts.dataDir,
      // KF-004：settings.personality 真实消费——persona 段进入系统提示
      persona: (opts.config?.settings as any)?.personality,
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
        const skills = discoverSkills(opts.dataDir ?? resolveDataDir(process.cwd()), process.cwd());
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
        // 审查修复：压缩摘要（role=system 带「压缩摘要」标记）跨轮保留——
        // 此前只放行 user/assistant，/compact 或自动压缩写入 DB 的摘要下一轮被过滤，
        // 压缩过的中间细节彻底丢失（压缩白做，长会话跨轮智能度衰减）
        if (h.role === 'user' || h.role === 'assistant' || (h.role === 'system' && String(h.content ?? '').includes('压缩摘要'))) {
          // 规避（image_url 400 防御纵深）：历史 content 若为多模态 parts 数组一律文本化
          // （image_url → [图片] 占位，dataUrl 绝不进入 API 消息——纯文本模型会 400）。
          msgs.push({ role: h.role, content: typeof h.content === 'string' ? h.content : contentToText(h.content) });
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
      : prompt + recallBlock + (imageDesc ? `\n[附加图片（视觉通道识别）] ${imageDesc}` : '') });
    // 文本模型图片识别结果同步入历史（视觉模型的异步摘要走下方 attachImageSummary——
    // 两条路径都保证后续轮次可回忆「看过什么图」）
    try { opts.mem.append(sessionId, 'user', imageDesc ? `${prompt}\n[附加图片（视觉通道识别）] ${imageDesc}` : prompt); } catch { /* 记忆写入失败不阻断对话 */ }
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
    // 深度：签名级循环检测缓冲（最近 8 轮工具调用签名）
    const recentToolSigs: string[] = [];
    // 读工具结果缓存（回合内）：模型探索型任务常见同参重读/重搜（实测 35 次工具调用
    // 大量重复浪费）——重复读调用合并返回缓存省时省 token；任何写/执行类工具
    // （bash/fs_write/fs_edit…）执行后整体清空——缓存绝不跨写失效
    const READ_TOOL_CACHE = new Set(['ls', 'grep', 'find_files', 'fs_read', 'web_search', 'http_get', 'repo_map', 'memory_search', 'command_search', 'tool_search']);
    const toolCache = new Map<string, string>();
    let unknownRounds = 0;
    let finalText = '';
    // KF-023/024：回合终态在函数作用域声明（finally 与尾部共用同一 ok）
    let ok = false;
    let status: AgentResult['status'] | undefined;
    bus.emit('agent.start', { sessionId, prompt });
    hooks?.userPromptSubmit?.(prompt, sessionId);
    // 审查修复：turns===0 时首轮尚未开始——此前 ===1 恒假（turns 在 while 内才 ++），
    // sessionStart hook 永不触发（死分支）
    if (turns === 0) hooks?.sessionStart?.(sessionId);

    // 系统性闭环保障：任何提前返回都必须发 agent.message（最终文本）+ agent.end——
    // 网关只在 agent.end 时发布 message.complete，漏发 = 回合静默结束、UI 无输出
    // （历史缺陷：错误路径 return 带文本但从未投递到 UI，「35 工具调用后无输出」真根因之一）
    const finishEarly = (text: string): AgentResult => {
      if (text) bus.emit('agent.message', { content: text });
      bus.emit('agent.end', { ok: false, turns });
      return { ok: false, text, turns, interrupted: st.interrupted };
    };

    try {
    while (turns < (opts.maxTurns ?? MAX_TURNS)) {
      if (st.aborted) { st.interrupted = true; break; }
      // 预算硬停（settings.budgetStop）：超预算后不再发起任何模型调用——显式失败闭环
      // （finishEarly 保证 agent.message + agent.end 事件可见，绝不静默空输出）。
      // 同步检查置于门控之前——本回合开始即生效（首个调用也不放过）
      if (budgetStop && budgetTokens) checkBudget();
      if (budgetExceeded && budgetStop) {
        return finishEarly(`会话 token 预算已达上限（${budgetTokens}）——settings.budgetStop=true 已停止对话；/compact 压缩上下文或 /new 新会话后继续（/config set budgetStop false 取消硬停）`);
      }
      // 余额耗尽自动停（余额监控实测 0）——同样走 finishEarly 显式失败闭环
      if (balanceAutoStop && (opts.config?.settings as any)?.balanceEmpty === true) {
        return finishEarly('余额已耗尽（余额监控实测 0）——/balance auto-stop on 已生效停止对话；充值后自动恢复，或 /balance auto-stop off 关闭');
      }
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
      // 水位预警（会话级一次）：75% 阈值提前告知——用户可主动 /compact，
      // 避免 85% 自动压缩「被动发生」（压缩会丢中间细节，主动压缩可选保留策略）
      if (used > ctxLimit * 0.75 && !ctxWarned) {
        ctxWarned = true;
        bus.emit('system.notice', { text: `上下文已用 ${Math.round((used / ctxLimit) * 100)}%（${used.toLocaleString()} token）——达到 85% 将自动压缩，可提前 /compact 主动压缩` });
      }
      if (used > ctxLimit * 0.85 && msgs.length > 10) {
        // P1-1：preCompact hook 可阻止压缩（输出 BLOCK）
        if (hooks?.preCompact?.(`auto: ${used}/${ctxLimit}`)) {
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
        let summaryText = '';
        try {
          const summaryMsg = condensed.find(m => m.role === 'system' && String(m.content ?? '').includes('压缩摘要'));
          summaryText = summaryMsg ? String(summaryMsg.content) : '';
          if (summaryText) {
            void opts.mem.compactSmart(sessionId, async () => summaryText).catch(() => { /* DB 同步失败不影响对话 */ });
          }
        } catch { /* 忽略 */ }
        const nextTokens = estimateMessagesTokens(msgs);
        // 架构 P3：压缩入事件流（时间线可审计）
        try {
          const { appendSessionEvent } = await import('./sessionStream.js');
          appendSessionEvent(opts.dataDir ?? resolveDataDir(process.cwd()), sessionId, { type: 'compact', summary: summaryText.slice(0, 200), before: used, after: nextTokens, ts: Date.now() });
        } catch { /* 静默 */ }
        bus.emit('system.notice', { text: `自动压缩完成（${used} → ${nextTokens} token）` });
        hooks?.postCompact?.(used, nextTokens);
        }
      }
      let res: ModelCall | ToolCallMsg;
      // A22：实时状态一句话——LLM 推理期（动态文本，UI 状态行显示）
      bus.emit('agent.stage', { stage: turns > 0 ? '正在推理下一步…' : '正在思考分析需求…' });
      try {
        res = await callWithAbort({ messages: msgs, tools: toolList });
      } catch (e: any) {
        if (st.aborted) { st.interrupted = true; break; }
        // 4xx 确定性错误（密钥无效/模型不存在/请求非法等）：不重试，立即反馈——
        // 否则无效 key 会空转 ~6s（3 次退避重试）才显示错误，被误判为「卡死」。
        // 429 限流除外：mapHttpError 语义为稍后重试，保留退避重试。
        if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 429) {
          bus.emit('agent.error', { message: String(e?.message ?? e) });
          return finishEarly(`模型调用失败：${e?.message?.slice(0, 200)}`);
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
          return finishEarly(`模型调用失败：${lastErr?.message?.slice(0, 200)}`);
        }
        continue;
      }
      if (res.type === 'text') {
        finalText = res.content;
        // 架构 P3：模型文本回复入事件流
        try {
          const { appendSessionEvent } = await import('./sessionStream.js');
          appendSessionEvent(opts.dataDir ?? resolveDataDir(process.cwd()), sessionId, { type: 'model', role: 'text', content: res.content.slice(0, 1000), ts: Date.now() });
        } catch { /* 静默 */ }
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
              return finishEarly('模型连续调用未知工具，已终止');
            }
            executed.push({ id: c.id, name: c.name, args: c.args, out: `工具 ${c.name} 不存在` });
            continue;
          }
          unknownRounds = 0;
          const cacheKey = `${c.name}:${JSON.stringify(c.args ?? {})}`;
          let out: string;
          let fromCache = false;
          if (READ_TOOL_CACHE.has(c.name) && toolCache.has(cacheKey)) {
            // 同参重复读调用：合并返回缓存（提示模型无需重跑）
            out = `${toolCache.get(cacheKey)}\n（结果已缓存——同参重复调用已合并，无需重跑）`;
            fromCache = true;
          } else {
            out = await executeTool(c.name, c.args);
            if (READ_TOOL_CACHE.has(c.name)) {
              if (toolCache.size >= 32) {
                const oldest = toolCache.keys().next().value;
                if (oldest !== undefined) toolCache.delete(oldest);
              }
              toolCache.set(cacheKey, out);
            } else {
              // 写/执行类工具：缓存全部失效（状态已变，旧读结果不可信）
              toolCache.clear();
            }
          }
          // KF-023/024：确定性结局累计——只有真实执行成功（postcondition 通过）的工具计入验证副作用
          if (!fromCache && lastToolOutcome === 'verified') rs.verifiedEffects++;
          if (out.includes('失败') || out.includes('异常')) anyFail = true;
          executed.push({ id: c.id, name: c.name, args: c.args, out, reasoning: c.reasoning, reasoningField: c.reasoningField });
          // 架构 P4：工具消息写 parts 分段（错误标记/截断标记独立 part——消息粒度可审计）
          try {
            const failed = out.includes('失败') || out.includes('异常');
            const truncated = out.includes('已截断');
            const parts = [
              { kind: 'tool', name: c.name, ok: !failed },
              { kind: failed ? 'error' : 'text', text: out.slice(0, 300), truncated: truncated || undefined },
            ];
            opts.mem.append(sessionId, 'tool', `${c.name}: ${out.slice(0, 300)}`, undefined, parts);
          } catch { /* 忽略 */ }
        }
        consecutiveFail = anyFail ? consecutiveFail + 1 : 0;
        if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
          bus.emit('agent.error', { message: `同工具连续失败 ${MAX_CONSECUTIVE_FAIL} 次，终止` });
          return finishEarly('同工具连续失败 5 次，已终止');
        }
        // 深度：签名级循环检测（Cline loop-detection 对齐）——相同 (工具,参数签名)
        // 重复 ≥3 次即空转（即使每次未报失败）——比「失败计数」更早识别死循环省 token
        const sig = executed.map(e => `${e.name}:${JSON.stringify(e.args ?? {}).slice(0, 120)}`).join('|');
        recentToolSigs.push(sig);
        if (recentToolSigs.length > 8) recentToolSigs.shift();
        const repeatCount = recentToolSigs.filter(s => s === sig).length;
        if (repeatCount >= 3) {
          bus.emit('agent.error', { message: `检测到工具调用循环（相同调用重复 ${repeatCount} 次），终止` });
          return finishEarly(`工具调用循环检测（相同调用重复 ${repeatCount} 次）——任务无进展，已终止；请换一种方式或拆分子任务`);
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
    // ── 轮次耗尽兜底（系统性闭环，绝不静默空输出）──
    // 工具全执行完但回合无最终文本：① 未被中断 → 无工具强制总结调用（tools:[]），
    // 让模型把已执行的工具结果收敛为答案；② 总结失败/被中断 → 显式失败文案。
    let exhausted = false;
    if (!finalText && !st.interrupted) {
      try {
        const r = await callWithAbort({
          messages: [...msgs, { role: 'system', content: '以上工具已全部执行完毕。请直接给出最终结论（中文，简洁），不要再调用任何工具。' }],
          tools: [],
        });
        if (r.type === 'text' && r.content.trim()) {
          finalText = r.content;
          bus.emit('agent.message', { content: finalText });
          try { opts.mem.append(sessionId, 'assistant', finalText); } catch { /* 忽略 */ }
        }
      } catch { /* 总结调用失败 → 下方显式兜底文案 */ }
    }
    if (!finalText) {
      exhausted = true;
      finalText = `任务执行了 ${turns} 轮（轮次上限）但未产出最终结论——工具调用已全部执行，过程已保留。建议 /rewind 回退后拆分子任务重试，或 /compact 压缩上下文后继续。`;
      bus.emit('agent.message', { content: finalText });
      try { opts.mem.append(sessionId, 'assistant', finalText); } catch { /* 忽略 */ }
    }
    // 自动标题（机制补强）：回合结束后若会话无标题，用首条用户消息前 20 字命名
    if (!opts2.subagent && finalText.length > 0) {
      try {
        const title = prompt.split('\n')[0]!.trim().slice(0, 20) || '新会话';
        opts.mem.setTitleIfEmpty(sessionId, title);
      } catch { /* 标题写入失败不阻断 */ }
    }
    // KF-023/024：ok 绝不从文本长度推导——完成声明（「完成了」/[GOAL_DONE]/done）且零验证副作用
    // → incomplete（诚实：普通问答/叙事文本不受影响；有验证副作用的完成声明正常成功）
    // 轮次耗尽兜底文案（exhausted）≠ 成功：显式 ok=false
    const claimedUnverified = finalText.length > 0 && isCompletionClaim(finalText) && rs.verifiedEffects === 0;
    ok = finalText.length > 0 && !claimedUnverified && !exhausted;
    status = claimedUnverified ? 'incomplete' : undefined;
    // C8 修复：错误路径也发 agent.end（ok:false）——事件契约对齐参考（错误也完成回合）
    bus.emit('agent.end', { ok, turns });
    // 架构 P3：回合结束入事件流
    try {
      const { appendSessionEvent } = await import('./sessionStream.js');
      appendSessionEvent(opts.dataDir ?? resolveDataDir(process.cwd()), sessionId, { type: 'end', ok, turns, ts: Date.now() });
    } catch { /* 静默 */ }
    hooks?.sessionEnd?.({ ok, turns });
    // P2-全方面：自动 checkpoint（Claude Code 每 prompt 快照对齐）——回合结束自动快照，
    // 保留最近 10 个（saveCheckpoint 内部循环清理）；/rewind 可回滚任意自动快照
    if (!opts2.subagent) {
      try {
        const { saveCheckpoint } = await import('../store/db.js');
        const msgsSnap = opts.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? ORDER BY id`).all(sessionId);
        saveCheckpoint(opts.db, sessionId, { kind: 'auto', messages: msgsSnap, ts: Date.now() });
      } catch { /* 快照失败不阻断（临时目录等） */ }
    }
    return { ok, text: finalText, turns, interrupted: st.interrupted, ...(status ? { status } : {}) };
    } finally {
      if (turn === st) turn = null; // C1：当前回合结束，释放 turn 引用
      // Stop hook：无论正常结束/中断/提前 return 都触发（不改 agent.end 总线语义）
      hooks?.stop?.({ ok, turns });
      if (opts2.subagent) {
        bus.emit('agent.subagent', { goal: prompt, phase: 'complete', ok, turns, session_id: sessionId, subagent_id: sessionId });
      }
    }
  }

  // loop-goal 模式（Kimi Ralph 同款）：目标驱动自主循环——
  // 模型自主规划/执行/自判完成（输出 [GOAL_DONE] 结束），直到完成或轮次上限；
  // 每轮 loop 独立回合（历史经 working 窗口延续上下文）
  const MAX_GOAL_ROUNDS = 10;
  async function runWithGoalLoop(prompt: string, images?: Array<{ dataUrl: string; mime: string }>, goalLoop?: boolean): Promise<AgentResult> {
    // goalLoop:false——命令层自循环（/goal）显式关闭内核 goal 模式，防内外层嵌套（默认行为不变）
    if (mode !== 'goal' || goalLoop === false) return loop(sessionId, prompt, { images });
    // KF-023：verifiedEffects 跨 goal 轮次累计——[GOAL_DONE] 声明须有 ≥1 个真实验证副作用才可 ok
    const rs = { verifiedEffects: 0 };
    const goalPrompt = `${prompt}\n\n（goal 模式：自主规划并持续执行直到目标全部完成。全部完成时回复末尾输出 ${GOAL_DONE_MARK}，未完成则继续执行。每轮都可以调用工具。）`;
    // A24：goal 进度实时上报（UI 后台面板「目标循环」区 + 状态行）
    bus.emit('agent.goal', { round: 1, maxRounds: MAX_GOAL_ROUNDS, done: false, text: prompt.slice(0, 80) });
    let result = await loop(sessionId, goalPrompt, { images, runState: rs });
    let rounds = 1;
    while (rounds < MAX_GOAL_ROUNDS && !result.interrupted && !result.text.includes(GOAL_DONE_MARK)) {
      rounds++;
      bus.emit('agent.stage', { stage: `goal 循环第 ${rounds}/${MAX_GOAL_ROUNDS} 轮…` });
      bus.emit('agent.goal', { round: rounds, maxRounds: MAX_GOAL_ROUNDS, done: false, text: result.text.slice(0, 80) });
      result = await loop(sessionId, `（goal 模式第 ${rounds} 轮）继续执行直到目标全部完成，完成后输出 ${GOAL_DONE_MARK}。以上文历史为当前进度。`, { runState: rs });
    }
    const done = result.text.includes(GOAL_DONE_MARK);
    bus.emit('agent.goal', { round: rounds, maxRounds: MAX_GOAL_ROUNDS, done, cancelled: result.interrupted, text: result.text.slice(0, 80) });
    if (done) {
      // 转义方括号（正则字符类）——[GOAL_DONE] 必须按字面匹配
      const esc = GOAL_DONE_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result.text = result.text.replace(new RegExp(`\\s*${esc}\\s*$`), '').trim();
    }
    return result;
  }

  // 降级状态按会话隔离：切换会话即复位（避免跨会话错误保持降级模型）
  let degradedForSession = sessionId;
  const resetDegradeIfNeeded = () => {
    if (degradedForSession !== sessionId) {
      void import('./llmStream.js').then(({ resetDegradedModel }) => resetDegradedModel());
      degradedForSession = sessionId;
    }
  };

  return {
    async run(prompt: string, opts?: { images?: Array<{ dataUrl: string; mime: string }>; goalLoop?: boolean }): Promise<AgentResult> {
      resetDegradeIfNeeded();
      return runWithGoalLoop(prompt, opts?.images, opts?.goalLoop);
    },
    spawnSubagent: spawnSub,
    // C1：abort 只作用于当前回合（若在跑）；空闲时置位无副作用
    abort() { const t = turn; if (t) { t.aborted = true; t.signal.abortController.abort(); t.signal.resolve(); } },
    setMode(m: Mode) { mode = m; },
    getMode(): Mode { return mode; },
    // A24：运行时切换工作目录（工具 ctx.cwd 跟随；repo_map 等 process.cwd() 读取
    // 由 gateway 侧 process.chdir 同步覆盖；dataDir 保持启动值）
    setCwd(path: string) { ctxCwd = path; },
    // A24 第四类修复：委派暂停真实状态（delegation.pause RPC → 内核生效）
    setDelegationPaused(paused: boolean) { delegationPaused = paused; },
    getDelegationPaused(): boolean { return delegationPaused; },
    // A25：委派深度上限读取（delegation.status caps 真实数据源——此前 UI 硬编码 3）
    getMaxSpawnDepth(): number { return MAX_SUBAGENT_DEPTH; },
    // F7：运行中注入消息（busy_input_mode: steer）
    steer(text: string): boolean { return steer(text); },
    // P1b：插件热重载——重建工具表（extraTools 合并 + excludeTools 过滤）
    updateTools(extra: Record<string, import('./tools.js').ToolDef>) {
      // KF-015：增量合并——多次 updateTools 各自 scope 共存（绝不整体重建覆盖先前注册）
      extraTools = { ...extraTools, ...extra };
      tools = Object.fromEntries(
        Object.entries({ ...coreTools(), ...extraTools }).filter(([n]) => !(opts.excludeTools ?? []).includes(n)),
      );
    },
    // 会话切换：多会话 UI 复用同一 agent 实例（消息经 mem.append 落库到目标会话）
    setSessionId(id: string) { sessionId = id; },
    // M4：当前会话读取——命令层（/undo /fork 等）定位真实会话，不再硬编码 'default'
    getSessionId(): string { return sessionId; },
    // ── 可执行剧本（/script）──────────────
    // 挂载/卸载录制器：录制期间每个工具调用回调（name/args），供 /script record 归集
    setScriptRecorder(fn: ((name: string, args: Record<string, any>) => void) | null) {
      scriptRecorder = fn;
    },
    // 剧本重放（WxScript DSL 解释器）：跳过 AI 决策，按序执行固定调用序列——
    // 确定性可复现。指令类型：
    //   { prompt, tools, expect? }  普通步骤（工具序列）
    //   { loop: { items, as?, do } }   循环（{{as}} 模板变量替换）
    //   { if: { outputContains, then, else? } }  条件（判断上一步输出）
    //   { parallel: [steps...] }     并行分支
    //   { task: { goal } }           子代理委派
    // 回放 CI：result 输出完整保留（不断言截断），带 step 索引供断言定位
    async runScript(steps: WxStep[]): Promise<{
      ok: boolean;
      log: WxLogEntry[];
    }> {
      // 与内部回归共用同一解释器（runScriptInternal）——避免两套逻辑漂移，
      // 也保证 /script run 与 auto 回归行为完全一致
      return runScriptInternal(steps);
    },
  };
}

// ── WxScript DSL 类型与工具函数 ─────────────────────────────
export type WxStep =
  | { prompt: string; tools: Array<{ name: string; args: Record<string, any> }>; expect?: string[] }
  | { loop: { items: string[]; as?: string; do: WxStep[] } }
  | { if: { outputContains: string; then: WxStep[]; else?: WxStep[] } }
  | { parallel: WxStep[] }
  | { task: { goal: string } };

export type WxLogEntry = {
  kind: 'prompt' | 'tool' | 'result' | 'loop' | 'if' | 'parallel' | 'task';
  step: number;
  text: string;
  name?: string;
};

/** 模板变量替换：{{as}} → item（递归应用于 steps 的 prompt/args 字符串） */
export function substituteVars(steps: WxStep[], varName: string, value: string): WxStep[] {
  const sub = (s: string): string => s.split(`{{${varName}}}`).join(value);
  const mapArgs = (args: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' ? sub(v) : v;
    return out;
  };
  return steps.map(st => {
    if ('loop' in st) return { loop: { ...st.loop, items: st.loop.items.map(sub), do: substituteVars(st.loop.do, varName, value) } };
    if ('if' in st) return { if: { ...st.if, then: substituteVars(st.if.then, varName, value), else: st.if.else ? substituteVars(st.if.else, varName, value) : undefined } };
    if ('parallel' in st) return { parallel: st.parallel.map(p => substituteVars([p], varName, value)[0]!) };
    if ('task' in st) return { task: { goal: sub(st.task.goal) } };
    return { prompt: sub(st.prompt), tools: st.tools.map(t => ({ name: t.name, args: mapArgs(t.args ?? {}) })), ...(st.expect ? { expect: st.expect } : {}) };
  });
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
