// src/bootstrap/cliComposition.ts — W8-00：组合根（config → repositories → kernel 三阶段装配）
// 第一刀：CLI 核心依赖（config/db/codeIndex/memoryRepository/mem）统一从组合根产出；
// 第二刀：kernel 阶段接管 bus/hookRunner/toolExecution/agent 工具表面/plugins/MCP/secrets/reloadMcp 装配——
// presentation（gateway/TUI/headless、命令注册、审批桥）经 KernelBridges 注入，CLI 只剩表现层。
// 固定阶段、失败只 dispose 已启动资源（fail-closed）、shutdown 幂等（bootstrapShutdown 语义）。
import { randomUUID } from 'node:crypto';
import type { Config } from '../store/config.js';
import type { Db } from '../store/db.js';
import type { Memory } from '../kernel/memory.js';
import type { MemoryRepository } from '../domain/memory/memoryRepository.js';
import type { CodeIndexRepository } from '../infrastructure/code/codeIndexRepository.js';
import type { EventBus } from '../kernel/events.js';
import type { createAgent } from '../kernel/agent.js';
import type { ProductionToolExecution } from '../application/tools/toolExecutionWiring.js';
import type { LoadedPlugin } from '../kernel/plugins.js';
import type { McpClient } from '../kernel/mcp.js';
import type { SecretVault } from '../kernel/secrets.js';
import type { OperationResult } from '../protocol/results.js';
import { configError } from '../domain/config/configSchema.js';
import { createShutdown } from './bootstrapShutdown.js';
// supremacy 1.2：小模型任务档（标题/摘要路由）——taskModels 纯函数 + CLI 侧装配 callOnce
import { resolveTaskModel, generateTitle } from '../kernel/taskModels.js';

/** 组合失败根因提取（纯函数可单测）：THREW 阶段的真实 cause 优先，否则回退错误码——诚实透出不吞真因。 */
export function composeFailureCause(result: OperationResult<unknown>): string {
  const fail = result as { ok: false; error?: { code?: string; details?: unknown } };
  const details = (fail.error?.details ?? {}) as Record<string, unknown>;
  return typeof details.cause === 'string' && details.cause ? details.cause : (fail.error?.code ?? '');
}

/** 表现层桥（CLI 注入）：gateway/TUI/headless 与命令总线依赖经此进入组合根——CLI 不再内联内核装配 */
export interface KernelBridges {
  approver(request: { toolId: string; args: unknown; effect: { kind: string }; reasonCode?: string; obligations?: unknown[] }): Promise<boolean>;
  onApproval(name: string, args: Record<string, any>): Promise<boolean>;
  onClarify(question: string, choices?: string[]): Promise<string>;
  onSecretRequest(kind: string, prompt: string, name?: string): Promise<string | null>;
  onFormRequest(fields: unknown[], prompt?: string): Promise<Record<string, string> | null>;
  onCommand(input: string): Promise<string>;
}

export interface CliCompositionDeps {
  dataDir: string;
  /** W7-00：主工作区根（下载/同化边界 + MCP cwd + 插件加载 cwd） */
  workspaceRoot: string;
  sessionId?: string;
  /** --strict-mcp-config（settings.strictMcpConfig 优先，二者或） */
  mcpStrict?: boolean;
  /** 表现层桥：缺省为 fail-closed 默认（approver/onApproval→拒绝、clarify→空、secret/form→null、command→空） */
  bridges?: KernelBridges;
}

export interface CliCompositionValue {
  config: Config;
  db: Db;
  codeIndex: CodeIndexRepository;
  memoryRepository: MemoryRepository;
  mem: Memory;
  bus: EventBus;
  /** agent 配置快照（与 agent 共享引用——CLI applyModel 热切换直接生效） */
  settings: Record<string, any>;
  toolExecution: ProductionToolExecution;
  agent: ReturnType<typeof createAgent>;
  plugins: LoadedPlugin[];
  /** MCP 客户端最新快照（reloadMcp 热换后读取最新） */
  getMcpClients(): McpClient[];
  reloadMcp(): Promise<{ ok: boolean; count: number; message: string }>;
  secrets: SecretVault;
  shutdown(reason: string): Promise<string[]>;
}

type Phase = (state: Readonly<Record<string, unknown>>) => Promise<OperationResult<{ patch?: Record<string, unknown>; resources?: Array<{ id: string; dispose(): void }> }>>;

const ORDER = ['config', 'repositories', 'kernel'] as const;

export async function createCliComposition(deps: CliCompositionDeps): Promise<OperationResult<CliCompositionValue>> {
  const state: Record<string, unknown> = {};
  const resources: Array<{ id: string; dispose(): void }> = [];
  const shutdown = createShutdown(resources);
  // MCP 快照 holder：kernel 阶段写入（reloadMcp 热换重绑）、值层 getter 读最新——组合根作用域共享
  const mcpHolder: { clients: McpClient[] } = { clients: [] };

  const phases: Record<(typeof ORDER)[number], Phase> = {
    config: async () => {
      const { createConfig } = await import('../store/config.js');
      return { ok: true, value: { patch: { config: createConfig(deps.dataDir) } } };
    },
    repositories: async () => {
      const { openDB, closeDB } = await import('../store/db.js');
      const { CodeIndexRepository: Repo } = await import('../infrastructure/code/codeIndexRepository.js');
      const { openMemoryRepository } = await import('../infrastructure/sqlite/memoryRepository.js');
      const db = openDB(deps.dataDir);
      const codeIndex = new Repo(db);
      codeIndex.install();
      const memoryRepository = openMemoryRepository(db, {
        now: () => Date.now(),
        idFactory: prefix => `${prefix}-${randomUUID()}`,
      });
      return {
        ok: true,
        value: {
          patch: { db, codeIndex, memoryRepository },
          resources: [{ id: 'db', dispose: () => { closeDB(db); } }],
        },
      };
    },
    kernel: async (current) => {
      const { createMemory } = await import('../kernel/memory.js');
      const { createMemoryShadow } = await import('../application/memory/memoryShadow.js');
      const { createEventBus } = await import('../kernel/events.js');
      const { createHookRunner } = await import('../kernel/hooks.js');
      const { connectAllMcp, mcpClientsToTools, closeAllMcp } = await import('../kernel/mcp.js');
      const { loadAllPlugins, pluginToolsToExtra } = await import('../kernel/plugins.js');
      const { createSecretVault } = await import('../kernel/secrets.js');
      const { deriveReadonlyTools, setReadonlyTools } = await import('../kernel/permissions.js');
      const { coreTools } = await import('../kernel/tools.js');
      const { createAgent } = await import('../kernel/agent.js');
      const { createAutoReview } = await import('../kernel/autoReview.js');
      const { createAgentApprovalBridge, createAgentToolSurface } = await import('../application/tools/agentToolSurface.js');
      const { createProductionToolExecution } = await import('../application/tools/toolExecutionWiring.js');
      const { DEFAULT_TOOL_POLICY, DEFAULT_TOOL_BUDGET_LIMITS } = await import('../application/tools/defaultToolPolicy.js');

      const config = current.config as Config;
      const db = current.db as Db;
      const dataDir = deps.dataDir;
      const workspaceRoot = deps.workspaceRoot;
      const memBase = createMemory(db);
      const mem = createMemoryShadow({ legacy: memBase, repository: current.memoryRepository as MemoryRepository, db });
      const bus = createEventBus(dataDir);
      // 稳定引用（config.get 快照缓存）：CLI 侧 applyModel 等热切换直接改此对象即生效
      const settings = config.get('settings') as Record<string, any>;
      // 表现层桥缺省 fail-closed——无网关/无命令总线时绝不静默放行
      const bridges: KernelBridges = deps.bridges ?? {
        approver: async () => false,
        onApproval: async () => false,
        onClarify: async () => '',
        onSecretRequest: async () => null,
        onFormRequest: async () => null,
        onCommand: async () => '',
      };

      // Hooks：settings.hooks 热生效（每次触发读当前配置），本地命令执行
      const hookRunner = createHookRunner(() => config.get('settings') as Record<string, any>, bus);

      // MCP 客户端（本地 stdio）：项目级 .mcp.json + 用户级 data/mcp.json 合并；
      // strictMcpConfig 开启时仅信任项目声明（生态对齐 Claude Code --strict-mcp-config）
      const mcpOpts = { cwd: workspaceRoot, strict: settings.strictMcpConfig === true || deps.mcpStrict === true };
      mcpHolder.clients = await connectAllMcp(dataDir, mcpOpts);

      // 插件系统（P0）：data/plugins/*/ 加载 → 工具并入 extraTools（命令注册在 commandBus 创建后）
      const plugins = await loadAllPlugins(dataDir, workspaceRoot, {
        on: (type, cb) => {
          const off = bus.on(type, (e: any) => { try { cb(e?.payload ?? {}); } catch { /* 插件回调异常不阻断 */ } });
          return off;
        },
        getConfig: (partition, key) => {
          try {
            const obj = config.get(partition as any);
            return key ? (obj as any)?.[key] : obj;
          } catch { return undefined; }
        },
      });
      // P3 安全注入：敏感数据内存保险库（用户亲手输入、仅内存、关闭即清）
      const secrets = createSecretVault();
      // 开放兼容：只读工具名单由内置工具表自动推导（danger!==true 即只读）——不再手工双写
      setReadonlyTools(deriveReadonlyTools(coreTools()));

      // W1-08：生产 ToolExecutionPipeline（11 ports 真实装配）——agent:* 工具经审批桥消费
      // （legacy 前置链已放行不二次弹窗）；非 agent 工具走表现层桥（gateway overlay）
      const agentApprovalBridge = createAgentApprovalBridge();
      const toolExecution = createProductionToolExecution({
        db, dataDir, workspaceRoot, memoryRepository: current.memoryRepository as MemoryRepository,
        policy: { id: 'policy-cli-v1', document: DEFAULT_TOOL_POLICY },
        budget: { id: 'budget-cli-v1', limits: { ...DEFAULT_TOOL_BUDGET_LIMITS } },
        approver: async (request) => {
          if (String(request.toolId).startsWith('agent:')) {
            return agentApprovalBridge.consume(request.args);
          }
          return bridges.approver(request);
        },
      });

      // C3：agent 工具表面（生产 pipeline 分层复用）——danger/写类工具经 11 ports 记账执行，
      // 只读工具维持 legacy（诚实 shadow，不伪装全面接管）
      const agentTool = createAgentToolSurface({ tools: { ...coreTools(), ...mcpClientsToTools(mcpHolder.clients), ...pluginToolsToExtra(plugins) } });
      const agentToolRegistration = toolExecution.registerAgentTools(agentTool.surface);
      if (!agentToolRegistration.ok) {
        return { ok: false, error: configError('AGENT_TOOL_SURFACE_REGISTRATION_FAILED', 'cli.composition.agent_tool_registration_failed', { cause: agentToolRegistration.error.code }) };
      }
      const agentToolRunner = agentTool.attach(toolExecution.pipeline, agentApprovalBridge);

      const agent = createAgent({
        db, bus, mem, sessionId: deps.sessionId ?? 'default', config: { settings },
        agentToolRunner,
        mode: settings.mode ?? 'smart',
        onApproval: bridges.onApproval,
        // C6：clarify 文字提问（UI clarify 面板真实回答）
        onClarify: bridges.onClarify,
        // P3 安全注入：敏感输入走 UI overlay（用户亲手输入）；非交互/未装配时返回 null（工具拒绝并提示）
        security: {
          sudoInjection: settings.security?.sudoInjection === true,
          secretInjection: settings.security?.secretInjection === true,
          vault: secrets,
        },
        onSecretRequest: bridges.onSecretRequest,
        // 动态内容表（credential_form 工具）：经 gateway 弹多字段表单
        onFormRequest: bridges.onFormRequest,
        // 简化人工操作（阶段 C）：smart 模式工作区内文件编辑自动放行（默认开启，/perm 说明）
        lowRiskAutoApprove: settings.lowRiskAutoApprove !== false,
        // P1-4 会话授权（approve_for_session）：settings.approveForSession=true 开启——
        // 批准一次本会话同键自动放行（session_grants 持久化）
        approveForSession: settings.approveForSession === true,
        dataDir,
        toolLazyLoad: settings.toolLazyLoad === true,
        // D 批次：AI 审批预审（settings.autoReview=true 开启）——用主模型单轮判断 allow/deny/ask。
        // 架构：独立单轮调用（callModelOnce）——不递归 agent.run（评审代理污染轮次状态）
        autoReview: createAutoReview(
          () => settings.autoReview === true,
          async (prompt) => {
            try {
              const { resolveApiKey } = await import('../kernel/providers.js');
              const { resolveDefaultModel, resolveDefaultBaseURL } = await import('../kernel/defaults.js');
              const { callModelOnce } = await import('../kernel/llmOnce.js');
              const keyRes = resolveApiKey(settings);
              if (!keyRes.key) return 'ask';
              const r = await callModelOnce({
                baseURL: resolveDefaultBaseURL(settings),
                model: resolveDefaultModel(settings),
                key: keyRes.key,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0,
                timeoutMs: 30_000,
              });
              return r.ok ? r.content : 'ask';
            } catch {
              return 'ask';
            }
          },
        ),
        hooks: hookRunner,
        extraTools: { ...mcpClientsToTools(mcpHolder.clients), ...pluginToolsToExtra(plugins) },
        // supremacy 1.2：小模型任务档——settings.titleModel 配置时标题走小模型（独立单轮、
        // 10s 超时、失败静默回退切片标题）；未配置/无密钥直接 null（零调用，行为=原版）
        titleGenerator: async (prompt) => {
          const titleModel = resolveTaskModel(settings, 'title');
          if (!titleModel) return null;
          try {
            const { resolveApiKey } = await import('../kernel/providers.js');
            const { resolveDefaultBaseURL } = await import('../kernel/defaults.js');
            const { callModelOnce } = await import('../kernel/llmOnce.js');
            const keyRes = resolveApiKey(settings);
            const key = keyRes.key;
            if (!key) return null;
            return await generateTitle(prompt, async (sys, usr) => {
              const r = await callModelOnce({
                baseURL: resolveDefaultBaseURL(settings),
                model: titleModel,
                key,
                messages: [
                  { role: 'system', content: sys },
                  { role: 'user', content: usr },
                ],
                temperature: 0,
                timeoutMs: 10_000,
              });
              return r.ok ? r.content : null;
            });
          } catch {
            return null;
          }
        },
        // supremacy 1.5：LLM 辅助循环检测（settings.loopJudge=true 开启，默认关）——
        // 重复达提醒阈值时单轮语义判定 loop/progress（10s 超时；无密钥/失败 → unknown 回退静态路径）
        loopJudge: settings.loopJudge === true
          ? async (evidence) => {
              try {
                const { resolveApiKey } = await import('../kernel/providers.js');
                const { resolveDefaultModel, resolveDefaultBaseURL } = await import('../kernel/defaults.js');
                const { callModelOnce } = await import('../kernel/llmOnce.js');
                const { buildLoopJudgePrompt, parseLoopVerdict } = await import('../kernel/loopJudge.js');
                const keyRes = resolveApiKey(settings);
                const key = keyRes.key;
                if (!key) return 'unknown';
                const { system, user } = buildLoopJudgePrompt(evidence.last, evidence.repeatCount);
                const r = await callModelOnce({
                  baseURL: resolveDefaultBaseURL(settings),
                  model: resolveDefaultModel(settings),
                  key,
                  messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                  ],
                  temperature: 0,
                  timeoutMs: 10_000,
                });
                return r.ok ? parseLoopVerdict(r.content) : 'unknown';
              } catch {
                return 'unknown';
              }
            }
          : undefined,
        // AI 自主调用通道（wx_cmd 工具）：桥闭包引用 CLI commandBus（命令注册在组合后完成，调用时才求值）
        onCommand: bridges.onCommand,
      });

      // MCP 热重载（/reload-mcp）：断开 → 重连 → updateTools 热换工具表（不重启进程）；
      // C3：agent 工具表面同步换表（runner.handles 实时生效）
      const reloadMcp = async (): Promise<{ ok: boolean; count: number; message: string }> => {
        try {
          closeAllMcp(mcpHolder.clients);
          const clients = await connectAllMcp(dataDir, mcpOpts);
          mcpHolder.clients = clients;
          agent.updateTools({ ...mcpClientsToTools(clients), ...pluginToolsToExtra(plugins) });
          agentTool.updateTools({ ...coreTools(), ...mcpClientsToTools(clients), ...pluginToolsToExtra(plugins) });
          return { ok: true, count: clients.length, message: `MCP 服务器已重载（${clients.length} 个在线）` };
        } catch (e: any) {
          return { ok: false, count: 0, message: `MCP 重载失败：${String(e?.message ?? e).slice(0, 120)}` };
        }
      };

      return {
        ok: true,
        value: {
          patch: { mem, bus, settings, toolExecution, agent, plugins, reloadMcp, secrets },
          resources: [{ id: 'mcp', dispose: () => { closeAllMcp(mcpHolder.clients); } }],
        },
      };
    },
  };

  for (const name of ORDER) {
    let result: OperationResult<{ patch?: Record<string, unknown>; resources?: Array<{ id: string; dispose(): void }> }>;
    try {
      result = await phases[name](state);
    } catch (cause) {
      result = { ok: false, error: configError('CLI_COMPOSITION_PHASE_THREW', 'cli.composition.phase_threw', { phase: name, cause: String((cause as Error).message ?? cause) }) };
    }
    if (!result.ok) {
      await shutdown(`cli-composition:${name}:failed`);
      return { ok: false, error: configError('CLI_COMPOSITION_PHASE_FAILED', 'cli.composition.phase_failed', { phase: name, cause: composeFailureCause(result) }) };
    }
    Object.assign(state, result.value.patch ?? {});
    resources.push(...(result.value.resources ?? []));
  }

  return {
    ok: true,
    value: {
      config: state.config as Config,
      db: state.db as Db,
      codeIndex: state.codeIndex as CodeIndexRepository,
      memoryRepository: state.memoryRepository as MemoryRepository,
      mem: state.mem as Memory,
      bus: state.bus as EventBus,
      settings: state.settings as Record<string, any>,
      toolExecution: state.toolExecution as ProductionToolExecution,
      agent: state.agent as ReturnType<typeof createAgent>,
      plugins: state.plugins as LoadedPlugin[],
      getMcpClients: () => mcpHolder.clients,
      reloadMcp: state.reloadMcp as CliCompositionValue['reloadMcp'],
      secrets: state.secrets as SecretVault,
      shutdown,
    },
  };
}
