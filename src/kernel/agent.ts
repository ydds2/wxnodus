// src/kernel/agent.ts — L2-4 agent 循环（核心）
// 设计（参考 ReAct 模式 + 事件驱动 harness + turn 控制器思想）：
//   run(prompt) 循环（≤32 轮）：
//     召回注入（黑洞引擎 FTS）→ 调模型（流式/工具）→ 文本流经事件总线
//     → 工具调用：permissions 检查 → 执行（danger 结果 untrusted 包裹）→ 回填
//     → 同工具连续失败 5 次终止 / 未知工具连续 3 轮终止 / 瞬时失败 800ms 退避重试
//     轮次耗尽兜底（系统性闭环）：工具执行完仍无文本 → 无工具强制总结调用收敛答案；
//     仍失败 → 显式失败文案。任何提前返回都发 agent.message + agent.end（UI 只在
//     agent.end 发布最终消息——漏发 = 回合静默、界面无输出）。
//   无 key → 明确引导 /model set-key（不假装回答）
//   spawnSubagent：独立上下文 + 只读工具集
import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
type Db = InstanceType<typeof Database>;
import { appendAudit } from './audit.js';
import type { EventBus } from './events.js';
import type { Memory } from './memory.js';
import { resolveDataDir } from './paths.js';
import { estimateMessagesTokens, compactMessages, contentToText, COMPRESSOR_SYSTEM_PROMPT, summarizeOnce } from './memory.js';
import { coreTools, toolsToOpenAI, wrapDanger, type ToolCtx, type ToolDef } from './tools.js';
import { labelTruncate } from './truncate.js';
import { resolveModelForChat } from './profiles.js';
import { maxContextFor } from './providers.js';
import { checkSessionGrant, grantSession } from './sessionGrants.js';
import { providerPromptFor, resolveProviderForPrompt } from './providerPrompts.js';
import { trimToolsForModel } from './toolTrim.js';
import { buildExecPolicyIndex, applyExecPolicy } from './execPolicy.js';
import { modeVerdict, loadPermRules, applyRules, type Mode } from './permissions.js';
import { isCompletionClaim, GOAL_DONE_MARK } from './completionClaim.js';
import type { HookRunner } from './hooks.js';
import { resolve, relative, isAbsolute } from 'node:path';
import { loadProjectRules } from './projectRules.js';
import { layeredSettings } from './projectConfig.js';
import type { SubagentDefinition, SubagentRunOptions } from './subagentTypes.js';
import { createRunContext, type RunContext } from '../protocol/runs.js';

export interface ModelCall { type: 'text'; content: string; reasoning?: string; reasoningField?: string; usage?: LlmTurnUsage }
export interface LlmTurnUsage { promptTokens: number; completionTokens: number }
export interface ToolCallMsg { type: 'tool_call'; name: string; args: Record<string, any>; id?: string; reasoning?: string; reasoningField?: string; usage?: LlmTurnUsage; calls?: Array<{ id: string; name: string; args: Record<string, any>; reasoning?: string; reasoningField?: string }> }

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
  /** P1-4 会话授权（approve_for_session，kimi 对齐）：开启后用户批准一次 → 本会话内
   *  同键自动放行（session_grants 表持久化，跨重启生效）；deny 级联拒绝同键。 */
  approveForSession?: boolean;
  /** 数据目录（P0-2 审批规则文件 data/permissions.json 读取位置） */
  dataDir?: string;
  /** 启动时解析并规范化的工作区根；生产路径不得回读可变 process.cwd()。 */
  workspaceRoot?: string;
  /** AI 审批预审（/perm auto-review 开启）：LLM 预审代替人工弹窗，allow/deny/ask */
  autoReview?: { enabled: () => boolean; review: (req: { tool: string; args: string; cwd: string }) => Promise<'allow' | 'ask' | 'deny'> };
  /** 工具延迟加载（P2，默认关）：开启后首轮只注入核心工具 + tool_search，
   *  模型检索到高级工具后动态激活——省工具 schema token（Codex tool_search 自研版） */
  toolLazyLoad?: boolean;
  /** 小模型任务档标题生成（supremacy 1.2）：settings.titleModel 配置时由 CLI 注入（独立单轮小模型调用，
   *  10s 超时、失败静默）；未注入/返回 null/抛出 → 回退首行切片标题（诚实降级，行为不劣于原版） */
  titleGenerator?: (prompt: string) => Promise<string | null>;
  /** LLM 辅助循环检测（supremacy 1.5）：settings.loopJudge=true 时由 CLI 注入单轮语义判定
   *  （loop=提前硬停 / progress=复位签名计数 / unknown=回退静态提醒→硬停路径）；
   *  未注入 → 纯静态路径（默认，零额外调用） */
  loopJudge?: (evidence: { repeatCount: number; last: Array<{ name: string; args: string; outputHead: string }> }) => Promise<'loop' | 'progress' | 'unknown'>;
  /** AI 自主调用通道（wx_cmd 工具）：执行斜杠指令并返回文本输出（cli 装配 bus.execute 包装） */
  onCommand?: (input: string, signal?: AbortSignal) => Promise<string>;
  /** Agent 工具 runner；未装配时工具调用 fail-closed，生产代码不得回退直接 ToolDef.run。 */
  agentToolRunner?: {
    handles(name: string): boolean;
    execute(name: string, args: Record<string, any>, toolCtx: ToolCtx, runContext: RunContext): Promise<import('../protocol/results.js').OperationResult<{ output: string }>>;
  };
  /** 工具热更新的 canonical 同步闸；返回失败时 Agent 保留旧表。 */
  onToolTableUpdate?: (tools: Record<string, ToolDef>) => import('../protocol/results.js').OperationResult<void>;
}

export interface AgentRunOptions {
  images?: Array<{ dataUrl: string; mime: string }>;
  goalLoop?: boolean;
  signal?: AbortSignal;
  runContext?: RunContext;
}

const agentRunContext = new AsyncLocalStorage<RunContext>();
const agentSessionContext = new AsyncLocalStorage<{ activeSessionId: string }>();

export interface AgentResult {
  ok: boolean;
  text: string;
  turns: number;
  interrupted: boolean;
  /** 完成态细分（KF-023/024）：零验证副作用的完成声明 → 'incomplete'（exit 3）；普通失败/成功不设 */
  status?: 'succeeded' | 'failed' | 'incomplete' | 'cancelled';
}

const MAX_TURNS = 32;
// gap 硬编码修复（2026-08-18）：未知模型的保守上下文回退（不是压缩阈值本身——
// 真实阈值由模型目录 maxContext 派生，见 loop 内 ctxLimit 计算）
const FALLBACK_CTX_TOKENS = 64_000;

// ── A22：实时状态一句话——工具动词映射（动态短语，UI 状态行展示）──
const TOOL_STAGE_VERBS: Record<string, string> = {
  fs_read: '读取文件', fs_write: '写入文件', fs_edit: '编辑文件', apply_patch: '应用补丁', ls: '列出目录',
  grep: '搜索文本', find_files: '查找文件', bash: '执行命令', http_get: '抓取网页',
  http_request: '发送请求', memory_write: '写入记忆', memory_search: '检索记忆',
  scaffold_build: '构建项目', delegate: '派发子代理', ask_user: '询问用户',
  clarify: '请求澄清', todo: '更新任务清单', skill_load: '加载技能', repo_map: '扫描仓库',
  cron_create: '创建定时任务', credential_form: '录入凭据', wx_cmd: '执行指令',
  tool_search: '检索工具', command_search: '检索命令',
  lsp_diagnostics: 'LSP 诊断', lsp_hover: 'LSP 悬停', lsp_definition: 'LSP 定义',
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
// ── 循环防护默认值（gap 深化 2026-08-18：全部 settings 可覆盖，默认与既有行为一致）──
const RETRY_DELAY_MS = 800;          // 瞬时失败退避间隔（settings.retryDelayMs）
const MAX_CONSECUTIVE_FAIL = 5;      // 同工具连续失败终止阈值（settings.maxConsecutiveFail）
const MAX_UNKNOWN_TOOL_ROUNDS = 3;   // 连续未知工具轮终止阈值（settings.maxUnknownToolRounds）
const LOOP_REMIND_AT = 2;            // 重复签名 ≥N 注入策略提醒（gemini 分级：提醒→硬停）
const LOOP_HARD_STOP_AT = 5;         // 重复签名 ≥N 硬停（原 3 次直停误杀合法轮询——见 gap P1-2）
const LOOP_SIG_WINDOW = 8;           // 签名滑动窗口（settings.loopSigWindow）
const CHANT_REMIND_AT = 3;           // goal 轮间相同结论 ≥N 注入换策略提醒
const CHANT_STOP_AT = 5;             // goal 轮间相同结论 ≥N 终止（gemini 内容重复对齐）
const TOOL_CACHE_SIZE = 32;          // 读工具结果缓存上限（settings.toolCacheSize）

/** 数值设置解析（生产级：夹取防误配 + 非法值回退默认）——复用 toolOutput.clampInt 单一事实源 */
import { clampInt as clampN } from './toolOutput.js';

// supremacy 3.5：shortHash 下沉 kernel/hash.ts 叶子（微基准直连 + 分层去重）
import { shortHash } from './hash.js';
export { shortHash };



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
  // P2 修复：上一轮真实 prompt token（provider 响应 usage.promptTokens——状态栏上下文占用数据源）
  let lastPromptTokens = 0;
  // 演示工具隐藏（真实 cmd 实测缺陷：/plugin new 脚手架 example_greet 对「hello」被
  // 廉价模型选中 → 审批面板阻塞会话）。demo:true 标记 + 遗留 example_ 前缀启发式
  // （旧 plugin.json 无标记）一律不进模型工具集；WXNODUS_INCLUDE_DEMO_TOOLS=1 逃生门
  // （plugin-smoke 等演示脚本用）。工具仍在注册表/命令侧可用（人工经插件命令调用）。
  const DEMO_TOOL_RE = /^example_/;
  const includeDemoTools = process.env.WXNODUS_INCLUDE_DEMO_TOOLS === '1';
  // 按模型工具裁剪（supremacy 1.3 / A-04）：settings.toolTrim='off' 全量，'auto'（默认）按
  // 模型能力裁（文本模型不拿图片输出工具、小窗口文本模型不拿 GUI 套件）；目录未收录模型不裁。
  // assembleTools 是唯一装配点——初始化与 updateTools 热重载共用（裁剪永不漏挂），
  // 裁剪结果随装配缓存（getToolTrim 查询面）。
  const settingsAny0 = opts.config?.settings as Record<string, any> | undefined;
  let lastTrimInfo: { dropped: string[]; tier: 'full' | 'lite' } = { dropped: [], tier: 'full' };

  // V4 P1-10（B-10）：tool_search 工厂——纳入 assembleTools 装配链（updateTools 重建不再丢失懒加载入口）
  const makeToolSearchTool = (): ToolDef => ({
      schema: { type: 'function', function: { name: 'tool_search', description: '检索高级工具（按关键词，如 "图片" "网络" "视频"）——命中后该工具立即可用', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
      danger: false,
      async run({ query }) {
        const hits = searchTools(String(query ?? ''), tools);
        if (!hits.length) return '未找到匹配工具（可用核心工具：' + [...CORE_TOOL_NAMES].filter(n => n !== 'tool_search').join('、') + '）';
        for (const h of hits) activeToolNames?.add(h.name);
        return `已激活 ${hits.length} 个工具（下次调用可用）：\n` + hits.map(h => `- ${h.name}：${h.description}`).join('\n');
      },
    });

  const assembleTools = (): Record<string, ToolDef> => {
    const merged = Object.fromEntries(
      Object.entries({ ...coreTools(), ...extraTools })
        .filter(([n]) => !(opts.excludeTools ?? []).includes(n))
        .filter(([n, t]) => includeDemoTools || (!(t as ToolDef).demo && !DEMO_TOOL_RE.test(n))),
    );
    const r = trimToolsForModel(String(settingsAny0?.model ?? ''), merged, { mode: String(settingsAny0?.toolTrim ?? 'auto') });
    lastTrimInfo = { dropped: r.dropped, tier: r.tier };
    // V4 P1-10：懒加载开启时 tool_search 随装配注入（此前仅 createAgent 手工注入一次，
    // updateTools 重建即丢——/mcp add、/plugin reload 后模型再也检索不到高级工具）
    return opts.toolLazyLoad ? { ...r.tools, tool_search: makeToolSearchTool() } : r.tools;
  };
  let tools = assembleTools();
  const bus = opts.bus;
  if (lastTrimInfo.dropped.length > 0) {
    // 一次性告知（创建时广播；updateTools 重裁剪不重复打扰）
    bus.emit('system.notice', { text: `工具面已按模型裁剪（隐藏 ${lastTrimInfo.dropped.length} 个不适配工具）——/config set toolTrim off 恢复全量` });
  }
  let sessionId = opts.sessionId; // 可变：setSessionId 热切换（多会话）
  let mode = opts.mode ?? 'smart'; // 可变：/perm 切换经 setMode 热更新
  // 前缀稳定化（DeepSeek 上下文缓存命中，audit §13.43）：系统提示时间戳每回合变化会让
  // 整个历史前缀缓存永久 miss——按会话冻结首次时间（会话跨天后时间不再刷新，换取缓存命中）。
  const sessionClocks = new Map<string, Date>();

  // 会话 token 预算（Gemini general.budget 对齐）：settings.budgetTokens>0 时，
  // 会话累计用量超预算 → system.notice 告警一次（防刷屏）；0/缺省 = 不设限；
  // settings.budgetStop=true → 超出后硬停（后续轮次 finishEarly 显式失败，绝不静默）
  const budgetTokens = Number((opts.config?.settings as any)?.budgetTokens) || 0;
  const budgetStop = (opts.config?.settings as any)?.budgetStop === true;
  // gap 硬编码修复（2026-08-18）：MAX_TURNS 32 不再写死——settings.maxTurns 可配
  // （opencode agent.steps 对齐），夹取 1..200 防误配；opts.maxTurns 优先（调用方显式传）
  const settingsAny = opts.config?.settings as Record<string, any> | undefined;
  const MAX_TURNS_EFFECTIVE = Math.min(Math.max(Number(settingsAny?.maxTurns) || MAX_TURNS, 1), 200);
  // gap 深化（2026-08-18）：循环防护阈值全部 settings 化（默认 = 模块级常量，行为不变）
  // P1-4 approve_for_session：settings.approveForSession=true 时启用会话级真实授权
  const approveForSession = opts.approveForSession === true;
  const EFF = {
    retryDelayMs: clampN(settingsAny?.retryDelayMs, RETRY_DELAY_MS, 50, 60_000),
    maxConsecutiveFail: clampN(settingsAny?.maxConsecutiveFail, MAX_CONSECUTIVE_FAIL, 2, 50),
    maxUnknownToolRounds: clampN(settingsAny?.maxUnknownToolRounds, MAX_UNKNOWN_TOOL_ROUNDS, 1, 20),
    loopRemindAt: clampN(settingsAny?.loopRemindAt, LOOP_REMIND_AT, 2, 20),
    loopHardStopAt: clampN(settingsAny?.loopHardStopAt, LOOP_HARD_STOP_AT, 3, 50),
    loopSigWindow: clampN(settingsAny?.loopSigWindow, LOOP_SIG_WINDOW, 4, 32),
    chantRemindAt: clampN(settingsAny?.chantRemindAt, CHANT_REMIND_AT, 2, 20),
    chantStopAt: clampN(settingsAny?.chantStopAt, CHANT_STOP_AT, 3, 50),
    toolCacheSize: clampN(settingsAny?.toolCacheSize, TOOL_CACHE_SIZE, 4, 256),
    maxGoalRounds: clampN(settingsAny?.maxGoalRounds, 10, 1, 100),
    maxSubagentDepth: clampN(settingsAny?.maxSubagentDepth, 3, 1, 8),
  };
  // 余额耗尽自动停（余额监控护栏）：/balance auto-stop on 后，网关实测余额 ≤0
  // 写入 settings.balanceEmpty（运行时态，不落盘）→ 后续轮次硬停（显式失败闭环）
  const balanceAutoStop = ((opts.config?.settings as any)?.balanceMonitor as Record<string, any> | undefined)?.autoStop === true;

  // 阶段 2（AI 自主触发）：会话首轮自动注入仓库地图 + 技能清单（仅一次）——
  // 模型先看项目结构再动手、自主 skill_load，减少人工 /map 与 /skill list
  // V4 P3-6（B-2）：回合级标志按 sessionId Map 化——agent 经 setSessionId 复用切换会话后，
  // 旧实例级标志使会话 B 直接继承会话 A 的告警/硬停/水位状态（B 被误硬停或永无水位提示）
  const sessionFlags = new Map<string, { autoInjectDone: boolean; budgetWarned: boolean; budgetExceeded: boolean; ctxWarned: boolean }>();
  const flagsFor = (sid: string) => {
    let f = sessionFlags.get(sid);
    if (!f) {
      f = { autoInjectDone: false, budgetWarned: false, budgetExceeded: false, ctxWarned: false };
      sessionFlags.set(sid, f);
    }
    return f;
  };
  // V4 P2-3：真实 usage 水位源 + 字符估算校准系数（会话级滚动——真实/估算比例的 EMA）
  let lastRealPromptTokens: number | null = null;
  let estCalibration = 1;
  // 波 1 ⑤：摘要失败护栏（gemini chatCompressionService.ts:287-321 对标）——按会话隔离
  // （agent 实例可经 setSessionId 复用多会话，失败标记绝不跨会话污染）：失败一次 →
  // 该会话后续压缩直接确定性截断（不再烧 LLM）。summarizeRef 每回合指向当轮
  // callWithAbort（abort 信号随轮更新），护栏闭包跨回合持存（不随轮重建）。
  let summarizeRef: (text: string) => Promise<string> = async () => '';
  const summarizeGuards = new Map<string, (text: string) => Promise<string>>();
  const sessionSummarizeFor = (sid: string): ((text: string) => Promise<string>) => {
    let g = summarizeGuards.get(sid);
    if (!g) {
      g = summarizeOnce((text: string) => summarizeRef(text));
      summarizeGuards.set(sid, g);
      if (summarizeGuards.size > 32) summarizeGuards.delete(summarizeGuards.keys().next().value!); // 上限保护
    }
    return g;
  };
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
          // ③ 波 1：工具结果切片 300→900 字——fs_edit 的 diff 回显块（≤~800 字）需完整落库
          // 供 UI DiffRenderer 渲染；recall/absorb 另有截断保护，库体积影响可控
          try { opts.mem.append(sessionId, 'tool', `${tc.name}: ${out.slice(0, 900)}`); } catch { /* 忽略 */ }
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
    const flags = flagsFor(sessionId); // V4 P3-6（B-2）：会话隔离标志
    if (!budgetTokens || flags.budgetWarned) return;
    try {
      const row = opts.db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens),0) t FROM usage_stats WHERE session_id=?`).get(sessionId) as { t: number } | undefined;
      const total = row?.t ?? 0;
      if (total > budgetTokens) {
        flags.budgetWarned = true;
        flags.budgetExceeded = true;
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
    const configuredModel = String(s.model ?? '');

    // 离线 provider 不读取云端密钥槽位：历史密钥损坏或 provider 不匹配不能阻断本地推理。
    if (configuredModel.startsWith('offline:')) {
      // V4 裁撤轨 D-1：离线对话默认禁用（软着陆——逃生开关 WXNODUS_LEGACY_OFFLINE=1）
      const { legacyOfflineEnabled, OFFLINE_DEPRECATION_HINT } = await import('./env.js');
      if (!legacyOfflineEnabled()) {
        return { type: 'text', content: OFFLINE_DEPRECATION_HINT };
      }
      const { isOfflineModelReady } = await import('./offlineModel.js');
      if (isOfflineModelReady(configuredModel)) {
        const { callLlmStream } = await import('./llmStream.js');
        const r = await callLlmStream({
          baseURL: '', model: configuredModel, key: '',
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
        content: '离线模型未下载——请用 /offline pack download 预下载后断网可用（或 /model set-key 配置云端密钥）。',
      };
    }

    const { resolveApiKey } = await import('./providers.js');
    const keyRes = resolveApiKey(s);

    // enc 存在但解密失败（机器指纹变化/数据损坏）或密钥归属与当前模型 provider 不符——
    // 明确提示修复路径，而不是误导性的「未配置」或对端 401
    if (keyRes.source === 'enc' && !keyRes.key) {
      return { type: 'text', content: keyRes.error === 'provider-mismatch'
        ? (keyRes.hint ?? '密钥与当前模型 provider 不符——/key set <密钥> 重配或 /model 切换')
        : '密钥无法解密（机器环境变化或数据损坏？）——请用 /key set <密钥> 重新配置。' };
    }

    if (!keyRes.key) {
      // 无 key：所有对话输出必须经 AI 模型——不做假装回答，
      // 明确引导配置（配置类命令 /key 等仍本地可用）
      const q = (() => { const c = req.messages[req.messages.length - 1]?.content ?? ''; return typeof c === 'string' ? c : ''; })();
      return {
        type: 'text',
        content: q.trim()
          ? '当前未配置模型密钥，所有回答需要 AI 模型提供。请用 /model set-key <密钥> 配置后重试（配置类命令不受影响）。'
          : '（空输入）',
      };
    }

    const key = keyRes.key;

    const { resolveDefaultBaseURL } = await import('./defaults.js');
    // 有 key 即视为已配置：model/baseURL 缺失时用默认
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
      // V4 P2-1：重试可见信号（断网/限流/过载——「网络中断，第 n 次重连…」直达状态栏 notice）
      onRetryNotice: (text) => bus.emit('system.notice', { text }),
      waitNetworkMs: Number(settingsAny?.waitNetworkMs) > 0 ? Number(settingsAny?.waitNetworkMs) : undefined,
      // V4 P2-2：idle watchdog 双档 + 全程硬顶（settings.llmTimeoutMs 默认 30min）
      timeoutMs: Number(settingsAny?.llmTimeoutMs) > 0 ? Number(settingsAny?.llmTimeoutMs) : undefined,
      idleFirstChunkMs: Number(settingsAny?.llmFirstChunkMs) > 0 ? Number(settingsAny?.llmFirstChunkMs) : undefined,
      idleChunkGapMs: Number(settingsAny?.llmIdleChunkMs) > 0 ? Number(settingsAny?.llmIdleChunkMs) : undefined,
    });
    if (!r.ok) {
      const err = new Error(r.error) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    // V4 P2-3：真实 usage 回传（水位触发与校准的单一真实源——Anthropic compaction 同族）
    const turnUsage = r.usage ? { promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens } : undefined;
    // B2 真实用量统计：异步写库（失败静默，不阻断对话）——model 用实际调用模型（降级后）
    // 端点未上报 usage 时记 0 token 行（调用计数仍诚实；/usage unmeasured 单独口径，成本绝不虚高）
    // 成本五维（supremacy 1.4）：输入/输出/缓存命中/缓存未命中/推理 token（端点未上报字段为 0）
    try {
      opts.db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, reasoning_tokens, ts) VALUES (?,?,?,?,?,?,?,?)`)
        .run(sessionId, r.model, r.usage?.promptTokens ?? 0, r.usage?.completionTokens ?? 0, r.usage?.cacheHitTokens ?? 0, r.usage?.cacheMissTokens ?? 0, r.usage?.reasoningTokens ?? 0, Date.now());
    } catch { /* 统计失败不影响对话 */ }
    // 状态栏上下文占用：上一轮真实 prompt token（端点未上报 → 0，UI 诚实隐藏）
    lastPromptTokens = r.usage?.promptTokens ?? 0;
    if (r.usage && (r.usage.promptTokens || r.usage.completionTokens)) {
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
      return { type: 'tool_call', id: first.id, name: first.name, args: first.args, reasoning: first.reasoning, reasoningField: first.reasoningField, calls, usage: turnUsage };
    }
    return { type: 'text', content: r.content, reasoning: r.reasoning, reasoningField: r.reasoningField, usage: turnUsage };
  };
  const callModel = opts.callModel ?? defaultCallModel;

  // 子代理（F9 修复）：独立 agent 实例（独立 abort 状态）+ 深度限制 + 收窄工具集
  // 工具集排除：写文件/执行/委派/记忆写入/外联/提问（只读探索）+ 全部 danger 工具——
  // 审查修复：extraTools（MCP/插件）此前不在名单内，MCP 默认 danger:false 却在 smart 下
  // 无确认执行任意副作用（与 delegate「只读工具集」描述不符）；现按 danger 标志动态剔除
  const SUBAGENT_EXCLUDE = ['fs_write', 'fs_edit', 'bash', 'scaffold_build', 'delegate', 'memory_write', 'http_get', 'ask_user'];
  const MAX_SUBAGENT_DEPTH = EFF.maxSubagentDepth; // settings.maxSubagentDepth（默认 3）
  // A24 第四类修复：委派暂停真实生效（delegation.pause → setDelegationPaused）——
  // 暂停后 delegate 工具/任务系统的新委派被拒绝（诚实返回原因，而非假装执行）
  let delegationPaused = false;
  const spawnSub = async (
    goal: string,
    depth = 1,
    def?: SubagentDefinition,
    execution?: SubagentRunOptions,
  ): Promise<{ ok: boolean; output: string; turns: number; interrupted?: boolean; status?: string }> => {
    if (depth > MAX_SUBAGENT_DEPTH) {
      return { ok: false, output: `子代理深度超限（${MAX_SUBAGENT_DEPTH} 层）——请拆分子任务`, turns: 0 };
    }
    if (delegationPaused) {
      return { ok: false, output: '委派已暂停（delegation.pause）——用 /delegate resume 或 子代理面板恢复后再派发', turns: 0 };
    }
    const childSessionId = execution?.sessionId
      ?? execution?.context?.sessionId
      ?? `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // 子代理生命周期事件（独立实例，手动发事件保持 UI 可见）
    // C4 修复：subagent_id 稳定（start/complete 同 id，/agents 面板可正确闭合）
    bus.emit('agent.subagent', { goal, phase: 'start', session_id: childSessionId, subagent_id: childSessionId });
    hooks?.subagentStart?.(goal);
    bus.emit('agent.stage', { stage: `子代理执行中（深度 ${depth}）…` }); // 对比轮 5：状态条可见中间态
    const sub = createAgent({
      ...opts,
      config: {
        ...opts.config,
        settings: {
          ...opts.config.settings,
          ...(def?.model ? { model: def.model } : {}),
          ...(def?.baseURL ? { baseURL: def.baseURL } : {}),
        },
      },
      sessionId: childSessionId,
      onToolTableUpdate: undefined,
      maxTurns: Math.min(opts.maxTurns ?? MAX_TURNS_EFFECTIVE, 8),
      // P0-2：自定义 agent 定义生效——mode/指令覆盖/工具白名单（缺省保持只读子代理）
      // 审查修复：mode 继承父会话当前模式（/perm 切换后热生效）——此前恒 'smart'，
      // manual（全量确认）父会话委派后子代理 non-danger 工具自动放行，确认语义被静默降级
      mode: def?.mode ?? mode,
      systemPromptOverride: def?.systemPromptOverride,
      excludeTools: def?.tools
        ? [...new Set([...CORE_TOOL_NAMES, ...Object.keys(tools)])].filter(n => !def.tools!.includes(n))
        : [...new Set([
          ...SUBAGENT_EXCLUDE,
          ...Object.entries(tools)
            .filter(([, t]) => t.danger || t.canonical?.namespace === 'mcp' || t.canonical?.namespace === 'plugin')
            .map(([n]) => n),
        ])],
      // 审查修复：保留 preToolUse 安全钩子（DENY 拦截）——此前 hooks:null 使子代理
      // 工具调用绕过用户配置的安全钩子；sessionStart 等主会话钩子仍不继承（子代理不触发）
      hooks: hooks ? { preToolUse: hooks.preToolUse } : null,
    });
    // 白名单声明的工具在懒加载模式下也要激活（否则 schema 不可见）
    if (def?.tools && activeToolNames) {
      for (const t of def.tools) activeToolNames.add(t);
    }
    const abortChild = () => sub.abort();
    if (execution?.signal?.aborted) abortChild();
    else execution?.signal?.addEventListener('abort', abortChild, { once: true });
    try {
      const parentContext = agentRunContext.getStore();
      const childContext = execution?.context ?? createRunContext({
        sessionId: childSessionId,
        actorId: parentContext?.actorId ?? 'actor:subagent',
        source: parentContext?.source ?? 'worker',
      });
      const r = await sub.run(goal, { signal: execution?.signal, runContext: childContext });
      bus.emit('agent.subagent', { goal, phase: 'complete', ok: r.ok, turns: r.turns, session_id: childSessionId, subagent_id: childSessionId });
      hooks?.subagentStop?.({ ok: r.ok, output: r.text, turns: r.turns });
      return { ok: r.ok, output: r.text, turns: r.turns, interrupted: r.interrupted, status: r.status };
    } catch (cause) {
      const output = String((cause as Error)?.message ?? cause).slice(0, 300);
      bus.emit('agent.subagent', { goal, phase: 'complete', ok: false, turns: 0, output, session_id: childSessionId, subagent_id: childSessionId });
      hooks?.subagentStop?.({ ok: false, output, turns: 0 });
      throw cause;
    } finally {
      execution?.signal?.removeEventListener('abort', abortChild);
    }
  };

  const initialToolSync = opts.onToolTableUpdate?.(tools);
  if (initialToolSync && !initialToolSync.ok) {
    throw Object.assign(new Error(`工具目录初始化失败：${initialToolSync.error.code}`), { code: initialToolSync.error.code });
  }

  // A24：运行时工作目录（目录选择器 /cwd 切换）——工具 ctx.cwd 动态读取；
  // dataDir 保持启动值（会话数据与记忆不随目录迁移——切换只影响文件/命令操作）
  let ctxCwd = opts.workspaceRoot ?? process.cwd();
  const agentDataDir = opts.dataDir ?? resolveDataDir(ctxCwd);

  const toolCtx: ToolCtx = {
    // getter：setCwd 后工具侧实时跟随（值快照会滞留旧目录）
    get cwd() { return ctxCwd; },
    // W3 Memory：可信 sessionId（agent 内部状态，绝不经工具参数伪造——memory_* 工具的 scope 来源）
    get sessionId() { return sessionId; },
    dataDir: agentDataDir,
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
    runCommand: opts.onCommand
      ? (input, signal) => opts.onCommand!(input, signal)
      : undefined,
    hookFailure: (name, err) => hooks?.postToolUseFailure?.(name, err),
    // 开放通道 settings（computer_observe 视觉等）：agent 配置直读
    // B-05 配置分层：项目级 .wxnodus/config.json settings 键级覆盖全局（每次调用动态合并）
    getSettings: () => layeredSettings(opts.config?.settings as Record<string, any> | undefined, ctxCwd),
  };

  // KF-010：默认审批 fail-closed——未装配 onApproval 时一律拒绝（绝不静默放行副作用）
  const onApproval = opts.onApproval ?? (async () => false);

  // P0-2 审批规则文件：启动加载 data/permissions.json，工具执行前应用（deny>allow>ask）
  const permRules = loadPermRules(agentDataDir);
  // supremacy 1.7：execpolicy 首词索引（codex first-token 机制）——bash 规则按命令首词
  // 预筛候选（pattern 锚定保证与全量 applyRules 等价），装配一次、逐工具调用复用
  const execPolicyIndex = buildExecPolicyIndex(permRules);

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

  async function executeTool(name: string, args: Record<string, any>, imgOut?: { images: Array<{ type: 'image_url'; image_url: { url: string } }> | null }): Promise<string> {
    lastToolOutcome = 'other';
    // C3 修复：工具调用稳定 id（start/complete 同 id，UI 工具卡可正确闭合）
    const toolId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // A25：事件带 session_id 标记（子代理会话为 <主>:sub 后缀——gateway 据此
    // 分流为 subagent.tool 富事件；此前子代理工具事件混入主面板或直接丢失）
    bus.emit('agent.tool', { name, args, phase: 'start', toolId, session_id: sessionId });
    // 架构 P3：工具调用入事件流（start）
    try {
      const { appendSessionEvent } = await import('./sessionStream.js');
      appendSessionEvent(agentDataDir, sessionId, { type: 'tool', name, phase: 'start', ts: Date.now() });
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
      // 深度：applyRules 支持 priority/modes/commandPrefix/denyMessage（Gemini policy 对齐）；
      // supremacy 1.7：bash 走 execpolicy 首词预筛（同语义、O(首词桶) 而非 O(全规则)）
      const ruleHit = name === 'bash'
        ? applyExecPolicy(String((args as any)?.command ?? ''), args, execPolicyIndex, mode)
        : applyRules(name, args, permRules, mode);
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
          verdict = modeVerdict(mode, name, args, tool.danger || tool.canonical?.namespace === 'mcp' || tool.canonical?.namespace === 'plugin');
        }
      } else {
        verdict = modeVerdict(mode, name, args, tool.danger || tool.canonical?.namespace === 'mcp' || tool.canonical?.namespace === 'plugin');
      }
      // A21：权限裁决留痕（工具/裁决/命令级别/参数摘要）
      auditTool('tool.verdict', {
        tool: name,
        verdict,
        level: cmdLevel,
        args: JSON.stringify(args ?? {}).slice(0, 200),
      });
      if (verdict === 'reject') return `工具被拒绝：权限红线（${name}）`;
      // P1-4 approve_for_session（kimi 对齐，gap 2026-08-18）：会话级真实授权（持久化 DB）——
      // deny 直拒（低于红线/规则 deny、高于模式判定）；allow 跳过确认链（cmdForceManual 的
      // wx_cmd danger 不受影响，仍强制人工）；授权表未就绪 → fail-closed 走确认链。
      let sessionGrantAllowed = false;
      if (approveForSession) {
        try {
          const sg = checkSessionGrant(opts.db, sessionId, name, args);
          if (sg === 'deny') {
            auditTool('tool.session-deny', { tool: name, args: JSON.stringify(args ?? {}).slice(0, 200) });
            return `工具被会话授权规则拒绝（${name}——/perm session-revoke 可撤销）`;
          }
          if (sg === 'allow' && !cmdForceManual) {
            sessionGrantAllowed = true;
            bus.emit('system.notice', { text: `会话授权放行：${name}（approve_for_session——/perm session-revoke 撤销）` });
          }
        } catch { /* 授权表未就绪 → 确认链（fail-closed） */ }
      }
      // 简化人工操作（阶段 C）：smart 模式 + 低危文件编辑（工作区内）→ 自动放行，
      // 不再逐次弹审批（acceptEdits 语义）；工作区外/危险操作/plan 模式不受影响
      const lowRiskFile = opts.lowRiskAutoApprove !== false && mode === 'smart'
        && (name === 'fs_write' || name === 'fs_edit')
        && typeof (args as any)?.path === 'string'
        && isPathWithinCwd(String((args as any).path), ctxCwd);
      if (sessionGrantAllowed) {
        // 已放行：跳过确认链（批准记录在下方 onApproval 回调处持久化）
      } else if (ruleHit?.decision === 'allow') {
        bus.emit('system.notice', { text: `规则放行：${name}（/perm rule list 查看）` });
      } else if (opts.autoReview?.enabled() && !cmdForceManual && (verdict === 'confirm' || verdict === 'plan')) {
        // AI 审批预审（D 批次）：LLM 预审代替人工弹窗——allow 放行（留痕）/ deny 拒绝 / ask 弹窗
        const verdict2 = await opts.autoReview.review({ tool: name, args: JSON.stringify(args ?? {}).slice(0, 500), cwd: ctxCwd });
        if (verdict2 === 'allow') {
          bus.emit('system.notice', { text: `AI 预审放行：${name}（auto-review）` });
        } else if (verdict2 === 'deny') {
          bus.emit('system.notice', { text: `AI 预审拒绝：${name}（auto-review）` });
          return `工具被 AI 预审拒绝（${name}）`;
        } else {
          const ok = await onApproval(name, args);
          if (!ok) return `用户拒绝执行 ${name}`;
          if (approveForSession) { try { grantSession(opts.db, sessionId, name, args, 'allow'); } catch { /* 忽略 */ } }
        }
      } else if (ruleHit?.decision === 'ask' && (verdict === 'approve' || verdict === 'confirm')) {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
        if (approveForSession) { try { grantSession(opts.db, sessionId, name, args, 'allow'); } catch { /* 忽略 */ } }
      } else if (verdict === 'confirm' && lowRiskFile) {
        bus.emit('system.notice', { text: `低危操作自动放行：${name}（工作区内文件编辑，${'/perm'} 可关闭）` });
      } else if (verdict === 'confirm' || verdict === 'plan') {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
        if (approveForSession) { try { grantSession(opts.db, sessionId, name, args, 'allow'); } catch { /* 忽略 */ } }
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
      const externalTool = tool.danger || tool.canonical?.namespace === 'mcp' || tool.canonical?.namespace === 'plugin';
      // F4：危险/外部工具输出统一 untrusted 包裹（提示注入防护）
      // 所有 Agent 可见工具必须由 canonical runner 接管；未接线或目录漂移时 fail-closed。
      const runner = opts.agentToolRunner;
      if (!runner?.handles(name)) {
        bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0, toolId, session_id: sessionId });
        auditTool('tool.executed', { tool: name, ok: false, ms: Date.now() - t0, error: 'TOOL_PIPELINE_UNAVAILABLE', pipeline: false });
        lastToolOutcome = 'failed';
        return `工具执行失败（TOOL_PIPELINE_UNAVAILABLE）：canonical pipeline 未注册 ${name}`;
      }
      const runContext = agentRunContext.getStore();
      if (!runContext) {
        bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0, toolId, session_id: sessionId });
        auditTool('tool.executed', { tool: name, ok: false, ms: Date.now() - t0, error: 'RUN_CONTEXT_UNAVAILABLE', pipeline: false });
        lastToolOutcome = 'failed';
        return `工具执行失败（RUN_CONTEXT_UNAVAILABLE）：当前工具调用未绑定 RunContext`;
      }
      const pres = await runner.execute(name, args, toolCtx, runContext);
      if (!pres.ok) {
        bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0, toolId, session_id: sessionId });
        auditTool('tool.executed', { tool: name, ok: false, ms: Date.now() - t0, error: pres.error?.code, pipeline: true });
        lastToolOutcome = 'failed';
        return `工具执行失败（${pres.error?.code ?? 'TOOL_EXECUTE_FAILED'}）：${pres.error?.message ?? ''}`;
      }
      const raw = pres.value.output;
      // ③ 波 1：图片输入通道——extractImages 钩子在执行现场（toolCtx 作用域内）收集图片
      // parts；imgOut 出参回传（并行批次安全——无共享状态），失败静默 null（不阻断工具结果）
      if (tool.extractImages && imgOut) {
        try { imgOut.images = await tool.extractImages(args, toolCtx); } catch { imgOut.images = null; }
      }
      // P0-2：vault 值输出脱敏——工具输出回填模型前，按内存敏感值精确替换（最后防线）
      const v = toolCtx.secrets?.vault;
      const vaultValues = v ? v.secretNames().map(n => v.getSecret(n)).filter((x): x is string => !!x) : [];
      const safe = vaultValues.length ? (await import('./redact.js')).redactVaultValues(raw, vaultValues) : raw;
      // gap P0-1 落地（2026-08-18）：工具输出 offload——超阈值（默认 50KB/2000 行）
      // 落盘 dataDir/truncations/ + 头尾预览 + 续读路径（opencode 思路，全工具统一覆盖）；
      // 未达 offload 阈值但超包裹面（settings.untrustedWrapLimit）→ 诚实截断标注（绝不静默）。
      const { offloadToolOutput, resolveWrapLimit } = await import('./toolOutput.js');
      const oSettings = toolCtx.getSettings?.() ?? undefined;
      const off = (oSettings?.toolOutputOffload as boolean | undefined) !== false
        ? offloadToolOutput({ tool: name, text: safe, dataDir: agentDataDir, sessionId, settings: oSettings })
        : null;
      let out: string;
      if (off) {
        out = externalTool ? wrapDanger(off.preview) : off.preview;
      } else if (externalTool && !safe.startsWith('<untrusted_tool_result>')) {
        // 工具已自包裹（bash 等自带 offload/标注）→ 原样透传（避免双重包裹/双重标注）；
        // 未包裹的危险输出 → 包裹面护栏 + 诚实截断标注（settings.untrustedWrapLimit）
        const wrapLimit = resolveWrapLimit(oSettings);
        const cut = safe.length > wrapLimit;
        const wrapped = wrapDanger(cut ? safe.slice(0, wrapLimit) : safe, wrapLimit);
        out = cut
          ? `${wrapped}\n…[输出已截断（共 ${safe.length} 字，剩余 ${safe.length - wrapLimit} 字未读）——用更精确的命令分段获取（重定向到文件/sed/tail）]`
          : wrapped;
      } else {
        out = safe;
      }
      bus.emit('agent.tool', { name, phase: 'complete', ok: true, ms: Date.now() - t0, toolId, session_id: sessionId });
      hooks?.postToolUse?.(name, out);
      // A21：工具执行结果留痕（耗时/成败）
      auditTool('tool.executed', { tool: name, ok: true, ms: Date.now() - t0 });
      // 架构 P3：工具完成入事件流
      try {
        const { appendSessionEvent } = await import('./sessionStream.js');
        appendSessionEvent(agentDataDir, sessionId, { type: 'tool', name, phase: 'complete', ok: true, ms: Date.now() - t0, ts: Date.now() });
      } catch { /* 静默 */ }
      // 变更即回归：文件被真实修改后调度 auto 剧本重放（防抖合并连续改动；
      // 回归重放期间的 fs_write 由 regressionRunning 守卫拦截，不会自我触发）
      if (name === 'fs_write' || name === 'fs_edit' || name === 'apply_patch') scheduleAutoRegression();
      // 文件变更不隐式 stage/commit。Git 历史属于独立高影响操作，只能由用户显式请求并经过工具审批。
      lastToolOutcome = 'verified';
      return out;
    } catch (e: any) {
      lastToolOutcome = 'failed';
      bus.emit('agent.tool', { name, phase: 'complete', ok: false, ms: Date.now() - t0, toolId, session_id: sessionId });
      auditTool('tool.executed', { tool: name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 120) });
      return `工具执行异常：${e?.message?.slice(0, 300) ?? e}`;
    }
  }

  /** KF-023/024：单次 run 的已验证工具副作用计数（跨 goal 轮次累计） */
  interface RunState { verifiedEffects: number }

  async function loop(sessionId: string, prompt: string, opts2: { subagent?: boolean; images?: Array<{ dataUrl: string; mime: string }>; runState?: RunState; signal?: AbortSignal } = {}): Promise<AgentResult> {
    const rs = opts2.runState ?? { verifiedEffects: 0 };
    // 架构 P3：会话事件流（可重放/审计）——用户消息入流
    try {
      const { appendSessionEvent } = await import('./sessionStream.js');
      appendSessionEvent(agentDataDir, sessionId, { type: 'user', content: prompt.slice(0, 500), ts: Date.now() });
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
    const abortTurn = () => {
      st.aborted = true;
      st.signal.abortController.abort();
      st.signal.resolve();
    };
    if (opts2.signal?.aborted) abortTurn();
    else opts2.signal?.addEventListener('abort', abortTurn, { once: true });
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
    // 前缀稳定化：系统提示时间戳按会话冻结（sessionClocks）——否则每回合时间变化
    // 使 DeepSeek 上下文缓存从第一段消息起永久 miss。
    const sessionClock = sessionClocks.get(sessionId) ?? new Date();
    sessionClocks.set(sessionId, sessionClock);
    msgs.push({ role: 'system', content: opts.systemPromptOverride ?? buildSystemPrompt({
      mode, cwd: ctxCwd, model: modelName, hasImageIn: hasImageIn(modelName), sessionId,
      // 开放兼容：/lang 设置生效（输出语言）+ dataDir 支持外部 prompts/system.md 覆盖
      lang: (opts.config?.settings as any)?.lang,
      dataDir: opts.dataDir,
      // KF-004：settings.personality 真实消费——persona 段进入系统提示
      persona: (opts.config?.settings as any)?.personality,
      // supremacy 1.1：分族提示词（provider 由 model/端点派生，会话内稳定——前缀缓存不受影响）
      providerPrompt: providerPromptFor(resolveProviderForPrompt(modelName, (opts.config?.settings as any)?.baseURL))?.body,
      now: sessionClock,
    }) });
    // 项目规范注入（生态规范文件链）：AGENTS.md/CLAUDE.md/GEMINI.md/.cursorrules 等
    // 首个存在者进系统提示（多工具共存——一套项目规范多 CLI 消费）
    // V4 P4-1：分层加载（全局 dataDir > 向上 4 层——子目录覆盖仓库根）+ 上限可配（projectDocMaxBytes）
    const settingsForRules = (opts.config?.settings as any) ?? {};
    const projectRules = loadProjectRules(ctxCwd, {
      dataDir: agentDataDir,
      maxBytes: Number(settingsForRules.projectDocMaxBytes) > 0 ? Number(settingsForRules.projectDocMaxBytes) : undefined,
    });
    if (projectRules) {
      const layerLabel = projectRules.layer === 'global' ? '全局规范' : projectRules.layer === 'subdir' ? '子目录规范' : '仓库规范';
      msgs.push({ role: 'system', content: `（${layerLabel} ${projectRules.file}——AGENTS.md 项目层与跨会话记忆互补）\n${projectRules.text}` });
    }
    // 阶段 2（AI 自主触发）：会话首轮极轻量注入（仅一次，防 token 浪费）——
    // ① 顶层结构一行（几十字符：模型有方向感，细节按需 repo_map，不挤占上下文）
    // ② 技能名称清单（一行：模型自主 skill_load）
    // ③ autoRepoMap=true 显式开启时，才注入完整仓库地图（≤400 token，默认关闭）
    const flags = flagsFor(sessionId); // V4 P3-6（B-2）
    if (!flags.autoInjectDone) {
      flags.autoInjectDone = true;
      try {
        const { scanProject } = await import('./projectScan.js');
        const profile = scanProject(ctxCwd);
        if (profile.structure.length) {
          msgs.push({ role: 'system', content: `（项目顶层结构）${profile.structure.slice(0, 12).join(' / ')}——需要了解符号/文件细节时调用 repo_map 工具` });
        }
      } catch { /* 结构注入失败不影响 */ }
      try {
        const { discoverSkills } = await import('./skills.js');
        const skills = discoverSkills(agentDataDir, ctxCwd);
        if (skills.length) {
          msgs.push({ role: 'system', content: `（可用技能：${skills.slice(0, 10).map(s => s.name).join('、')}——需要时用 skill_load 加载）` });
        }
      } catch { /* 技能清单注入失败不影响 */ }
      if ((opts.config?.settings as any)?.autoRepoMap === true) {
        try {
          const { buildRepoMap } = await import('./repoMap.js');
          const rm = buildRepoMap(ctxCwd, { budgetTokens: 400 });
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
        // V4 P2-7：被打断回合的工具产出回放（gemini functionResponse 跨轮可见对标——
        // 此前 tool 消息被上方循环过滤，「基于以上进度继续」注记与实际不可见的工具产出矛盾）。
        // DB 无 assistant(tool_calls) 配对消息——原生 tool role 回放会破 OpenAI 协议配对，
        // 故以聚合块注入（协议安全 + 信息可见性等价）：尾部连续工具结果，有界最近 6 条、每条 300 字。
        const tailTools: string[] = [];
        for (let hi = history.length - 1; hi >= 0 && history[hi]!.role === 'tool' && tailTools.length < 6; hi--) {
          tailTools.unshift(labelTruncate(String(history[hi]!.content ?? ''), 300));
        }
        const toolBlock = tailTools.length
          ? '\n[上回合工具产出（被打断前最近 ' + tailTools.length + ' 条）]\n' + tailTools.join('\n---\n')
          : '';
        msgs.push({ role: 'system', content: `（上回合任务被打断——请基于以上进度继续完成，而不是重新开始）${toolBlock}` });
      }
    } catch { /* 历史加载失败不阻断 */ }
    // 召回注入（黑洞引擎：FTS 命中历史上下文；限定当前会话防串记忆）
    // 每条 300 字截断显式标注（labelTruncate 统一口径——模型知道有剩余，可 memory_search 查全文）
    const recalled = await opts.mem.recallHybrid(prompt, { limit: 3, sessionId });
    const recallBlock = recalled.length
      ? `\n[相关历史记忆（本会话）]\n${recalled.map(r => labelTruncate(String(r.content ?? ''), 300)).join('\n---\n')}`
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
    let compactedThisTurn = false; // V4 P2-3：413 强压重发仅一次（防压缩后仍超限的循环）
    // 深度：签名级循环检测缓冲（最近 EFF.loopSigWindow 轮工具调用签名——含输出短哈希）
    const recentToolSigs: string[] = [];
    // 循环提醒已注入标记（gap P1-2：分级响应——提醒只注入一次防刷屏，硬停阈值后置）
    let loopReminded = false;
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
    while (turns < (opts.maxTurns ?? MAX_TURNS_EFFECTIVE)) {
      if (st.aborted) { st.interrupted = true; break; }
      // 预算硬停（settings.budgetStop）：超预算后不再发起任何模型调用——显式失败闭环
      // （finishEarly 保证 agent.message + agent.end 事件可见，绝不静默空输出）。
      // 同步检查置于门控之前——本回合开始即生效（首个调用也不放过）
      if (budgetStop && budgetTokens) checkBudget();
      if (flagsFor(sessionId).budgetExceeded && budgetStop) {
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
      // （真实窗口×0.85 或 +reserved>=窗口）→ 自动压缩内存消息后继续当前回合
      // gap 硬编码修复（2026-08-18）：64k 不再写死——压缩阈值 = 模型目录真实窗口
      // − 输出预留（opencode overflow.ts 思路：默认 min(20k, 25%×窗口)，预留模型
      // 输出空间；settings.ctxOutputReserve 可覆盖）；未知模型回退 FALLBACK_CTX_TOKENS。
      // 子代理保持 64k 封顶（独立小上下文）。
      const modelCtx = maxContextFor(String(settingsAny?.model ?? ''));
      const rawReserve = Number(settingsAny?.ctxOutputReserve);
      const outReserve = Number.isFinite(rawReserve) && rawReserve > 0
        ? rawReserve
        : Math.min(20_000, Math.max(4_000, Math.floor((modelCtx ?? FALLBACK_CTX_TOKENS) * 0.25)));
      const ctxBase = opts2.subagent
        ? Math.min(modelCtx ?? FALLBACK_CTX_TOKENS, FALLBACK_CTX_TOKENS)
        : (opts.maxContextTokens ?? modelCtx ?? FALLBACK_CTX_TOKENS);
      const ctxLimit = Math.max(4_000, ctxBase - outReserve);
      // V4 P2-3：真实 usage 优先（Anthropic compaction 口径——服务端 token 计数为准）；
      // 估算经校准系数修正（真实/估算 EMA）；无真实值时退化为校准估算。保守取大值。
      const estRaw = estimateMessagesTokens(msgs);
      if (lastRealPromptTokens !== null && estRaw > 0) {
        estCalibration = estCalibration * 0.7 + (lastRealPromptTokens / estRaw) * 0.3;
      }
      const used = lastRealPromptTokens !== null
        ? Math.max(lastRealPromptTokens, Math.round(estRaw * estCalibration))
        : estRaw;
      // V4 P2-3：阈值可配（默认 0.75 提早压缩——Anthropic 60-80% 口径；95% 后再压已迟：
      // 大请求反复超限连环失败 5-15min。settings.compactionThreshold 对齐 gemini compressionThreshold）
      const compactAt = clampN(settingsAny?.compactionThreshold, 0.75, 0.5, 0.95);
      // 水位预警（会话级一次）：75% 阈值提前告知——用户可主动 /compact，
      // 避免 85% 自动压缩「被动发生」（压缩会丢中间细节，主动压缩可选保留策略）
      const flags = flagsFor(sessionId); // V4 P3-6（B-2）
      if (used > ctxLimit * (compactAt - 0.10) && !flags.ctxWarned) {
        flags.ctxWarned = true;
        bus.emit('system.notice', { text: `上下文已用 ${Math.round((used / ctxLimit) * 100)}%（${used.toLocaleString()} token${lastRealPromptTokens !== null ? ' · 真实用量' : ''}）——达到 ${Math.round(compactAt * 100)}% 将自动压缩，可提前 /compact 主动压缩` });
      }
      if (used > ctxLimit * compactAt && msgs.length > 10) {
        // V4 P2-3：micro-compaction 先行——旧工具结果裁剪（尾部 6 条消息外 tool 内容截断
        // 到 500 字；kimi 0.12 默认开启同族语义）。轻裁后若已降到阈值下，跳过全量压缩
        // （保近轮完整 + 省一次摘要 LLM 调用与前缀缓存）。
        let freed = 0;
        const keepRecent = 6;
        for (let mi = 0; mi < msgs.length - keepRecent; mi++) {
          const mm = msgs[mi] as { role?: string; content?: unknown };
          if (mm?.role !== 'tool') continue;
          const text = typeof mm.content === 'string' ? mm.content : '';
          if (text.length > 800) {
            mm.content = `${text.slice(0, 500)}\n[micro-compaction：旧工具结果已裁剪（原 ${text.length} 字）]`;
            freed += text.length - 500;
          }
        }
        if (freed > 0) {
          const afterMicro = estimateMessagesTokens(msgs);
          if (afterMicro <= ctxLimit * compactAt) {
            bus.emit('system.notice', { text: `micro-compaction：裁剪旧工具结果腾出空间（${used} → ${afterMicro} token）——保留近轮完整，未触发全量压缩` });
          }
        }
        // P1-1：preCompact hook 可阻止压缩（输出 BLOCK）
        if (await hooks?.preCompact?.(`auto: ${used}/${ctxLimit}`)) {
          bus.emit('system.notice', { text: '压缩被 hook 阻止（preCompact BLOCK）' });
        } else {
        bus.emit('system.notice', { text: `上下文已达 ${Math.round((used / ctxLimit) * 100)}%（${used} token）——自动压缩…` });
        // 本回合的摘要实现（独立单轮请求——前缀缓存工程，结果只写回主对话）
        summarizeRef = async (text) => {
          const r = await callWithAbort({
            messages: [
              { role: 'system', content: COMPRESSOR_SYSTEM_PROMPT },
              { role: 'user', content: text },
            ],
            tools: [],
          });
          return r.type === 'text' ? r.content : '';
        };
        // 波 1 ⑤：已有快照合并锚定（gemini chatCompressionService.ts:353-359 对标）——
        // 找到最近一条压缩摘要作为 priorSummary 传入（未完成事项/约束不丢）
        let priorSummary: string | undefined;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const pm = msgs[i] as any;
          if (pm?.role === 'system' && String(pm.content ?? '').includes('压缩摘要')) {
            priorSummary = String(pm.content).replace(/^\s*（自动压缩摘要）\s*/, '');
            break;
          }
        }
        const condensed = await compactMessages(msgs as any, sessionSummarizeFor(sessionId), { priorSummary });
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
          appendSessionEvent(agentDataDir, sessionId, { type: 'compact', summary: summaryText.slice(0, 200), before: used, after: nextTokens, ts: Date.now() });
        } catch { /* 静默 */ }
        bus.emit('system.notice', { text: `自动压缩完成（${used} → ${nextTokens} token）` });
        hooks?.postCompact?.(used, nextTokens);
        }
      }
      let res: ModelCall | ToolCallMsg | undefined;
      // A22：实时状态一句话——LLM 推理期（动态文本，UI 状态行显示）
      bus.emit('agent.stage', { stage: turns > 0 ? '正在推理下一步…' : '正在思考分析需求…' });
      try {
        res = await callWithAbort({ messages: msgs, tools: toolList });
      } catch (e: any) {
        if (st.aborted) { st.interrupted = true; break; }
        // V4 P2-3：413/context-length 语义捕获 → 强制压缩后自动重发一次
        // （kimi 0.20.2 同族；此前只提示手动 /compact——超限回合直接报废）
        const overLimit = e?.status === 413 || /context length|maximum context|context_window|too many tokens/i.test(String(e?.message ?? ''));
        if (overLimit && !compactedThisTurn) { // 超限是服务端事实——不受 msgs>10 门槛（水位压缩的门槛不适用于救场）
          compactedThisTurn = true;
          bus.emit('system.notice', { text: '上下文超限（413/context length）——强制压缩后自动重发…' });
          const condensed2 = await compactMessages(msgs as any, sessionSummarizeFor(sessionId), {});
          msgs.splice(0, msgs.length, ...condensed2);
          try {
            const { appendSessionEvent } = await import('./sessionStream.js');
            appendSessionEvent(agentDataDir, sessionId, { type: 'compact', summary: 'over-limit forced', before: used, after: estimateMessagesTokens(msgs), ts: Date.now() });
          } catch { /* 静默 */ }
          try { res = await callWithAbort({ messages: msgs, tools: toolList }); } catch { /* 重发仍失败落入下方常规错误路径 */ }
          if (res) { lastRealPromptTokens = res.usage?.promptTokens ?? lastRealPromptTokens; continue; }
        }
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
          await new Promise(r => setTimeout(r, EFF.retryDelayMs * (tried + 1)));
          // V4 P0-9（A-4）：重发前发流重置信号——UI 清空失败尝试的半截输出再接收重试全文，
          // 杜绝「半截旧文 + 完整新文」拼接显示（gemini StreamEventType.RETRY 同语义）。
          // 语义增量已有 token 推到屏幕的场景同理适用（presentationReducer 按 reset 清空）。
          bus.emit('agent.token', { text: '', reset: true });
          try { res = await callWithAbort({ messages: msgs, tools: toolList }); break; }
          catch (e2: any) { if (st.aborted) { st.interrupted = true; break; } lastErr = e2; tried++; }
        }
        if (st.interrupted) break;
        if (tried >= 3) {
          bus.emit('agent.error', { message: String(lastErr?.message ?? lastErr) });
          return finishEarly(`模型调用失败：${lastErr?.message?.slice(0, 200)}`);
        }
        // V4 P0-9（A-3）：重试成功后不再 continue——此前 continue 丢弃已成功的 res 并
        // 重新发起全新模型调用（token 已流到 UI 后丢弃重来：重复流式输出+双倍计费+多耗一轮）。
        // 重试成功的 res 直接落入下方正常处理（text/tool_call 分支）。
        if (!res) continue; // definite-assignment 防御（理论不可达：interrupted 已 break、耗尽已 return）
      }
      // V4 P2-3：捕获本轮真实 usage（下一轮水位触发的单一真实源）
      if (res.usage) lastRealPromptTokens = res.usage.promptTokens;
      if (res.type === 'text') {
        finalText = res.content;
        // 架构 P3：模型文本回复入事件流
        try {
          const { appendSessionEvent } = await import('./sessionStream.js');
          appendSessionEvent(agentDataDir, sessionId, { type: 'model', role: 'text', content: res.content.slice(0, 1000), ts: Date.now() });
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
        // 批量工具调用（对比轮 5 修复）：同回合全部 tool_calls 一次回填
        const batch = res.calls?.length
          ? res.calls.map(c => ({ id: c.id ?? `call_${Date.now().toString(36)}${turns}`, name: c.name, args: c.args ?? {}, reasoning: c.reasoning, reasoningField: c.reasoningField }))
          : [{ id: res.id ?? `call_${Date.now().toString(36)}${turns}`, name: res.name, args: res.args ?? {}, reasoning: res.reasoning, reasoningField: res.reasoningField }];
        const executed: Array<{ id: string; name: string; args: Record<string, any>; out: string; reasoning?: string; reasoningField?: string; images?: Array<{ type: 'image_url'; image_url: { url: string } }> | null; outcome?: 'verified' | 'failed' | 'other' | 'cached' }> = [];
        let anyFail = false;
        // gap P1-1 落地（2026-08-18）：并行工具调度（gemini scheduler 同款语义）——
        // 批次含任一 danger（写/执行/外联）→ 整批严格串行（保证写后读顺序与审批链）；
        // 纯只读批次且非 manual 模式（manual 下只读也逐项审批，并行会并发弹窗）→
        // Promise.all 并行执行，结果按原始槽位回填（assistant.tool_calls 顺序不变）。
        const runOneCall = async (c: (typeof batch)[number]): Promise<typeof executed[number]> => {
          if (!tools[c.name]) {
            // 未知工具：跳过该调用（计入阈值防模型空转），其余调用继续执行
            unknownRounds++;
            return { id: c.id, name: c.name, args: c.args, out: `工具 ${c.name} 不存在`, reasoning: c.reasoning, reasoningField: c.reasoningField, outcome: 'failed' as const };
          }
          // V4 P1-6：参数 JSON 哨兵——不执行，结构化错误回喂模型自纠（码+解释+建议）
          if (c.args && typeof c.args === 'object' && ARGS_PARSE_ERROR_KEY in (c.args as Record<string, unknown>)) {
            const raw = String((c.args as Record<string, unknown>)[ARGS_PARSE_ERROR_KEY] ?? '');
            return {
              id: c.id, name: c.name, args: c.args, reasoning: c.reasoning, reasoningField: c.reasoningField,
              outcome: 'failed' as const,
              out: `参数 JSON 无效（工具 ${c.name} 未执行）：模型输出的 arguments 不是合法 JSON——原文片段：${raw.slice(0, 80)}。请整体重新调用该工具，并确保 arguments 为合法 JSON（检查引号/括号闭合/换行转义）。`,
            };
          }
          unknownRounds = 0;
          const cacheKey = `${c.name}:${JSON.stringify(c.args ?? {})}`;
          // V4 L0-2：调用级结构化结局（verified/failed/other/cached）——anyFail、消息 parts、
          // executed 轨迹三处消费同一确定性信号，废除「输出含『失败/异常』子串」内容猜测
          // （A-5 误杀根治：grep 中文代码库/读含『失败』字样日志不再触发连续失败终止）
          let callOutcome: 'verified' | 'failed' | 'other' | 'cached' = 'other';
          let out: string;
          let fromCache = false;
          let images: Array<{ type: 'image_url'; image_url: { url: string } }> | null = null;
          if (READ_TOOL_CACHE.has(c.name) && toolCache.has(cacheKey)) {
            // 同参重复读调用：合并返回缓存（提示模型无需重跑）
            out = `${toolCache.get(cacheKey)}\n（结果已缓存——同参重复调用已合并，无需重跑）`;
            fromCache = true;
            callOutcome = 'cached';
          } else {
            const imgSlot: { images: Array<{ type: 'image_url'; image_url: { url: string } }> | null } = { images: null };
            out = await executeTool(c.name, c.args, imgSlot);
            const outcome = lastToolOutcome; // 立即捕获本调用的确定性结局（并行下防串扰）
            callOutcome = outcome;
            // ③ 波 1：图片输入通道——extractImages 在执行现场收集（imgOut 出参，并行安全）；
            // 仅视觉模型会话附加进 msgs（纯文本模型绝不收 dataUrl）
            images = imgSlot.images;
            // 空输出归一（诚实）：'' 工具结果会让模型误判「结果丢失/幻觉」——显式「（无输出）」语义明确
            if (!out) out = '（工具无输出——操作可能已成功或无需返回内容）';
            // gap P2-4 落地（2026-08-18）：工具输出蒸馏（settings.toolDistill=true 开关，
            // 默认关——二次调用有成本；子代理不蒸馏防递归计费；失败保持原输出诚实降级）
            if ((settingsAny?.toolDistill as boolean | undefined) === true && !opts2.subagent) {
              try {
                const { resolveDistillThreshold, DISTILL_INPUT_CHARS } = await import('./toolOutput.js');
                if (out.length > resolveDistillThreshold(settingsAny)) {
                  const dr = await callWithAbort({
                    messages: [
                      { role: 'system', content: '你是工具输出蒸馏器：把下面的工具输出摘要为 ≤500 字的中文要点（保留文件路径/行号/数值/结论，去掉重复与噪音）。只输出摘要本身。' },
                      { role: 'user', content: out.slice(0, DISTILL_INPUT_CHARS) },
                    ],
                    tools: [],
                  });
                  if (dr.type === 'text' && dr.content.trim()) out = `[已蒸馏（原 ${out.length} 字 → ${dr.content.length} 字）]\n${dr.content.trim()}`;
                }
              } catch { /* 蒸馏失败保持原输出（诚实降级，不阻断） */ }
            }
            if (READ_TOOL_CACHE.has(c.name)) {
              if (toolCache.size >= EFF.toolCacheSize) {
                const oldest = toolCache.keys().next().value;
                if (oldest !== undefined) toolCache.delete(oldest);
              }
              toolCache.set(cacheKey, out);
            } else {
              // 写/执行类工具：缓存全部失效（状态已变，旧读结果不可信）
              toolCache.clear();
            }
            // KF-023/024：确定性结局累计——只有真实执行成功（postcondition 通过）的工具计入验证副作用
            if (!fromCache && outcome === 'verified') rs.verifiedEffects++;
          }
          if (callOutcome === 'failed') anyFail = true; // V4 L0-2：确定性结局（A-5 子串启发式废除）
          // 架构 P4：工具消息写 parts 分段（错误标记/截断标记独立 part——消息粒度可审计）
          try {
            const failed = callOutcome === 'failed'; // V4 L0-2：结构化结局（消息 parts 错误标记）
            const truncated = out.includes('已截断');
            const parts = [
              { kind: 'tool', name: c.name, ok: !failed },
              { kind: failed ? 'error' : 'text', text: out.slice(0, 900), truncated: truncated || undefined },
            ];
            opts.mem.append(sessionId, 'tool', `${c.name}: ${out.slice(0, 900)}`, undefined, parts);
          } catch { /* 忽略 */ }
          return { id: c.id, name: c.name, args: c.args, out, reasoning: c.reasoning, reasoningField: c.reasoningField, images, outcome: callOutcome };
        };
        const hasWrite = batch.some(c => tools[c.name]?.danger === true);
        if (!hasWrite && mode !== 'manual') {
          // 纯只读批次并行（slot 保序——结果顺序与模型 tool_calls 完全一致）
          const slot: Array<typeof executed[number]> = new Array(batch.length);
          await Promise.all(batch.map(async (c, i) => { slot[i] = await runOneCall(c); }));
          for (let i = 0; i < batch.length; i++) executed.push(slot[i]!);
        } else {
          for (const c of batch) executed.push(await runOneCall(c));
        }
        if (unknownRounds >= EFF.maxUnknownToolRounds) {
          bus.emit('agent.error', { message: `连续 ${EFF.maxUnknownToolRounds} 轮未知工具，终止` });
          return finishEarly('模型连续调用未知工具，已终止');
        }
        consecutiveFail = anyFail ? consecutiveFail + 1 : 0;
        if (consecutiveFail >= EFF.maxConsecutiveFail) {
          bus.emit('agent.error', { message: `同工具连续失败 ${EFF.maxConsecutiveFail} 次，终止` });
          return finishEarly(`同工具连续失败 ${EFF.maxConsecutiveFail} 次，已终止`);
        }
        // 深度：签名级循环检测（Cline loop-detection 对齐）——签名并入输出短哈希
        // （crush 思想：同参数不同输出的空转也漏不掉）；分级响应（gemini P1-2 落地）：
        // ≥loopRemindAt 注入换策略提醒（给合法轮询恢复机会）→ ≥loopHardStopAt 硬停
        const sig = executed.map(e => `${e.name}:${JSON.stringify(e.args ?? {}).slice(0, 120)}:${shortHash(e.out)}`).join('|');
        recentToolSigs.push(sig);
        if (recentToolSigs.length > EFF.loopSigWindow) recentToolSigs.shift();
        const repeatCount = recentToolSigs.filter(s => s === sig).length;
        if (repeatCount >= EFF.loopHardStopAt) {
          bus.emit('agent.error', { message: `检测到工具调用循环（相同调用重复 ${repeatCount} 次），终止` });
          return finishEarly(`工具调用循环检测（相同调用重复 ${repeatCount} 次）——任务无进展，已终止；请换一种方式或拆分子任务`);
        }
        if (repeatCount >= EFF.loopRemindAt && !loopReminded) {
          // supremacy 1.5：LLM 辅助循环检测（settings.loopJudge，CLI 注入 loopJudge 时启用）——
          // 达到提醒阈值先语义判定一次：loop=提前硬停（不等硬停阈值空烧 token）；
          // progress=复位该签名计数（合法轮询继续，再爬到阈值会重新判定）；
          // unknown/异常=回退静态提醒→硬停路径（行为不劣于原版）
          let verdict: 'loop' | 'progress' | 'unknown' = 'unknown';
          if (opts.loopJudge) {
            try {
              const last = executed.slice(-3).map(e => ({ name: e.name, args: JSON.stringify(e.args ?? {}), outputHead: e.out.slice(0, 300) }));
              verdict = await opts.loopJudge({ repeatCount, last });
            } catch { verdict = 'unknown'; }
          }
          if (verdict === 'loop') {
            bus.emit('agent.error', { message: `LLM 判定重复调用无进展（${repeatCount} 次），提前终止` });
            return finishEarly(`LLM 循环判定：相同工具调用重复 ${repeatCount} 次且无进展——已提前终止（比静态阈值更早止损）；请换一种方式或拆分子任务（/config set loopJudge false 可关闭辅助判定）`);
          }
          if (verdict === 'progress') {
            // 合法重复：复位该签名计数（const 数组原地清本签名）——不注入提醒、不消耗
            // loopReminded（下次再爬到阈值重新判定）
            for (let i = recentToolSigs.length - 1; i >= 0; i--) {
              if (recentToolSigs[i] === sig) recentToolSigs.splice(i, 1);
            }
            bus.emit('system.notice', { text: `LLM 判定当前重复为合法操作（构建/重试/轮询）——继续执行` });
          } else {
            loopReminded = true;
            bus.emit('system.notice', { text: `检测到重复工具调用（${repeatCount} 次）——已注入换策略提醒；继续重复到 ${EFF.loopHardStopAt} 次将终止` });
            msgs.push({ role: 'system', content: '【循环提醒】你正在重复相同的工具调用且没有进展。请立即改变策略：换一种方法、拆分子任务、或调用 clarify 向用户澄清。' });
          }
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
        // ③ 波 1：图片输入通道——工具结果附带的图片 parts 以 user 消息附加进模型通道
        // （视觉模型会话才附加；纯文本模型由 toolTrim 白名单裁掉图片工具 + 这里双保险不附加）
        const imgOuts = executed.flatMap(e => e.images ?? []);
        if (imgOuts.length && hasImageIn(modelName)) {
          msgs.push({ role: 'user', content: [{ type: 'text', text: '（view_image 载入的图片内容，已附加）' }, ...imgOuts] });
        }
        // gap P2-4 落地（2026-08-18）：旧轮工具输出掩码（gemini masking——保护最新
        // 50k token，保护窗外超过触发量才掩码；settings.toolOutputMask=false 关闭；
        // 子代理不掩码——小上下文自带压缩）
        if ((settingsAny?.toolOutputMask as boolean | undefined) !== false && !opts2.subagent) {
          try {
            const { maskOldToolOutputs, resolveMaskWindow } = await import('./toolOutput.js');
            const win = resolveMaskWindow(settingsAny);
            const masked = maskOldToolOutputs(msgs as any, win);
            if (masked > 0) bus.emit('system.notice', { text: `已掩码 ${masked} 条早前工具输出（保护窗 ${win.protectTokens} token）——/compact 可将早前结果并入摘要` });
          } catch { /* 掩码失败不影响对话 */ }
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
    // 自动标题（机制补强 + supremacy 1.2 小模型任务档）：会话无标题时优先小模型生成（titleGenerator 注入），
    // 未配置/无密钥/失败/返回空 → 回退首条用户消息前 20 字切片（诚实降级，行为不劣于原版）。
    // 已有标题不触发任何调用（查库门——避免每回合浪费一次小模型请求）
    if (!opts2.subagent && finalText.length > 0) {
      try {
        const row = opts.db.prepare(`SELECT title FROM sessions WHERE id=?`).get(sessionId) as { title: string } | undefined;
        if (!row || !row.title.trim()) {
          // 注入器异常视为未配置（诚实降级）——小模型挂了绝不影响回合闭环
          let generated: string | null = null;
          if (opts.titleGenerator) {
            try { generated = await opts.titleGenerator(prompt); } catch { /* 回退切片 */ }
          }
          const title = generated ?? (prompt.split('\n')[0]!.trim().slice(0, 20) || '新会话');
          opts.mem.setTitleIfEmpty(sessionId, title);
        }
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
      appendSessionEvent(agentDataDir, sessionId, { type: 'end', ok, turns, ts: Date.now() });
    } catch { /* 静默 */ }
    hooks?.sessionEnd?.({ ok, turns });
    // P2-全方面：自动 checkpoint（Claude Code 每 prompt 快照对齐）——回合结束自动快照，
    // 保留最近 10 个（saveCheckpoint 内部循环清理）；/rewind 可回滚任意自动快照
    // A-07 增量化：存 messagesUpTo 上界（消息只增不删）——不再每回合全量 SELECT 复制
    if (!opts2.subagent) {
      try {
        const { saveCheckpoint, snapshotMessagesUpTo } = await import('./checkpoint.js');
        const upTo = snapshotMessagesUpTo(opts.db, sessionId);
        saveCheckpoint(opts.db, sessionId, { kind: 'auto', ...upTo, ts: Date.now() });
      } catch { /* 快照失败不阻断（临时目录等） */ }
    }
    return { ok, text: finalText, turns, interrupted: st.interrupted, ...(status ? { status } : {}) };
    } finally {
      opts2.signal?.removeEventListener('abort', abortTurn);
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
  const MAX_GOAL_ROUNDS = EFF.maxGoalRounds; // settings.maxGoalRounds（默认 10）
  async function runWithGoalLoop(prompt: string, images?: Array<{ dataUrl: string; mime: string }>, goalLoop?: boolean, signal?: AbortSignal): Promise<AgentResult> {
    // goalLoop:false——命令层自循环（/goal）显式关闭内核 goal 模式，防内外层嵌套（默认行为不变）
    if (mode !== 'goal' || goalLoop === false) return loop(sessionId, prompt, { images, signal });
    // KF-023：verifiedEffects 跨 goal 轮次累计——[GOAL_DONE] 声明须有 ≥1 个真实验证副作用才可 ok
    const rs = { verifiedEffects: 0 };
    const goalPrompt = `${prompt}\n\n（goal 模式：自主规划并持续执行直到目标全部完成。全部完成时回复末尾输出 ${GOAL_DONE_MARK}，未完成则继续执行。每轮都可以调用工具。）`;
    // A24：goal 进度实时上报（UI 后台面板「目标循环」区 + 状态行）
    bus.emit('agent.goal', { round: 1, maxRounds: MAX_GOAL_ROUNDS, done: false, text: prompt.slice(0, 80) });
    let result = await loop(sessionId, goalPrompt, { images, runState: rs, signal });
    let rounds = 1;
    // gap P1-2（2026-08-18）：轮间结论重复检测（gemini 内容重复对齐）——相同最终文本
    // ≥chantRemindAt 注入换策略提醒、≥chantStopAt 终止（防 goal 模式空转烧 token）
    let chantRounds = 0;
    let prevText = '';
    while (rounds < MAX_GOAL_ROUNDS && !result.interrupted && !result.text.includes(GOAL_DONE_MARK)) {
      rounds++;
      bus.emit('agent.stage', { stage: `goal 循环第 ${rounds}/${MAX_GOAL_ROUNDS} 轮…` });
      bus.emit('agent.goal', { round: rounds, maxRounds: MAX_GOAL_ROUNDS, done: false, text: result.text.slice(0, 80) });
      const t = result.text.trim();
      chantRounds = t && t === prevText ? chantRounds + 1 : 0;
      prevText = t;
      if (chantRounds >= EFF.chantStopAt) {
        bus.emit('agent.error', { message: `goal 循环连续 ${chantRounds} 轮结论相同——判定空转，终止` });
        bus.emit('agent.goal', { round: rounds, maxRounds: MAX_GOAL_ROUNDS, done: false, cancelled: true, text: t.slice(0, 80) });
        return { ...result, ok: false, text: `${t}\n（goal 循环连续 ${chantRounds} 轮输出相同结论——判定空转，已终止；请换一种方式或明确补充要求）` };
      }
      const chantNote = chantRounds >= EFF.chantRemindAt
        ? `（检测到你连续 ${chantRounds} 轮给出相同结论——请换一种策略或给出新进展，不要重复相同内容。）`
        : '';
      result = await loop(sessionId, `（goal 模式第 ${rounds} 轮）继续执行直到目标全部完成，完成后输出 ${GOAL_DONE_MARK}。以上文历史为当前进度。${chantNote}`, { runState: rs, signal });
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
    async run(prompt: string, opts?: AgentRunOptions): Promise<AgentResult> {
      resetDegradeIfNeeded();
      const context = opts?.runContext ?? createRunContext({
        sessionId,
        actorId: 'actor:embedded',
        source: 'kernel',
      });
      return agentRunContext.run(context, () => agentSessionContext.run(
        { activeSessionId: context.sessionId },
        () => runWithGoalLoop(prompt, opts?.images, opts?.goalLoop, opts?.signal),
      ));
    },
    spawnSubagent: spawnSub,
    // C1：abort 只作用于当前回合（若在跑）；空闲时置位无副作用
    abort() { const t = turn; if (t) { t.aborted = true; t.signal.abortController.abort(); t.signal.resolve(); } },
    setMode(m: Mode) { mode = m; },
    getMode(): Mode { return mode; },
    // 状态栏上下文占用：上一轮真实 prompt token（P2 修复——此前 UI 只有累计 token 可显示）
    getLastPromptTokens(): number { return lastPromptTokens; },
    // 测试/嵌入式调用可原子更新 Agent 工作区；CLI 生产入口只在启动时设置。
    setCwd(path: string) { ctxCwd = path; },
    getCwd(): string { return ctxCwd; },
    // A24 第四类修复：委派暂停真实状态（delegation.pause RPC → 内核生效）
    setDelegationPaused(paused: boolean) { delegationPaused = paused; },
    getDelegationPaused(): boolean { return delegationPaused; },
    // A25：委派深度上限读取（delegation.status caps 真实数据源——此前 UI 硬编码 3）
    getMaxSpawnDepth(): number { return MAX_SUBAGENT_DEPTH; },
    // F7：运行中注入消息（busy_input_mode: steer）
    steer(text: string): boolean { return steer(text); },
    // 插件/MCP 热重载：候选完整表先通过 canonical catalog，成功后才提交 Agent 可见表。
    updateTools(
      extra: Record<string, import('./tools.js').ToolDef>,
      options?: { replaceNamespaces?: readonly ('mcp' | 'plugin')[] },
    ) {
      const candidateExtra = { ...extraTools };
      const replacedNamespaces = new Set(
        options?.replaceNamespaces
        ?? Object.values(extra)
          .map(tool => tool.canonical?.namespace)
          .filter((namespace): namespace is 'mcp' | 'plugin' => namespace === 'mcp' || namespace === 'plugin'),
      );
      for (const [name, tool] of Object.entries(candidateExtra)) {
        if (tool.canonical?.namespace && replacedNamespaces.has(tool.canonical.namespace as 'mcp' | 'plugin')) delete candidateExtra[name];
      }
      Object.assign(candidateExtra, extra);
      const previousExtra = extraTools;
      extraTools = candidateExtra;
      const candidate = assembleTools();
      const synced = opts.onToolTableUpdate?.(candidate);
      if (synced && !synced.ok) {
        extraTools = previousExtra;
        tools = assembleTools();
        throw Object.assign(new Error(`工具目录更新失败：${synced.error.code}`), { code: synced.error.code });
      }
      tools = candidate;
    },
    /** 按模型裁剪结果查询（supremacy 1.3）——UI/测试诊断面 */
    getToolTrim(): { dropped: string[]; tier: 'full' | 'lite' } { return { ...lastTrimInfo, dropped: [...lastTrimInfo.dropped] }; },
    // 会话切换在 Run 内只更新异步局部状态；Run 外更新交互式默认会话。
    setSessionId(id: string) {
      const local = agentSessionContext.getStore();
      if (local) local.activeSessionId = id;
      else sessionId = id;
    },
    // 命令层优先读取当前 Run 的会话，防止 HTTP/后台 Run 串到交互式默认会话。
    getSessionId(): string { return agentSessionContext.getStore()?.activeSessionId ?? sessionId; },
    withinSession<T>(id: string, operation: () => Promise<T>): Promise<{ value: T; activeSessionId: string }> {
      return agentSessionContext.run({ activeSessionId: id }, async () => {
        const value = await operation();
        return { value, activeSessionId: agentSessionContext.getStore()?.activeSessionId ?? id };
      });
    },
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
function isPathWithinCwd(p: string, cwd = process.cwd()): boolean {
  try {
    const rel = relative(resolve(cwd), resolve(cwd, p));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch { return false; }
}

// V4 P1-6：工具参数 JSON 坏的哨兵键——runOneCall 检测后不执行、错误回喂模型自纠
// （opencode InvalidTool / codex RespondToModel 同族；此前静默吞 {} → 工具以空参执行
// 报误导错误，模型收不到「我的 JSON 坏了」信号）
export const ARGS_PARSE_ERROR_KEY = '__wxnodus_args_parse_error__';

function safeJson(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return { [ARGS_PARSE_ERROR_KEY]: String(s ?? '').slice(0, 120) }; }
}
