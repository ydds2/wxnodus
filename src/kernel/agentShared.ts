// src/kernel/agentShared.ts — ⅩⅩⅪ 拆分：agent.ts 共享层（类型/常量/纯函数/durable 队列接线）
// 从 agent.ts 提取的零闭包依赖面——agent.ts 主循环保留闭包设计（域内聚是刻意的），
// 本文件承载可独立测试/复用的共享层。
import type Database from 'better-sqlite3';

// ═══ 类型定义 ═══
export type Mode = 'smart' | 'auto' | 'manual' | 'plan' | 'yolo' | 'goal';

export interface AgentOptions {
  db: Database.Database;
  bus: { on(type: string, fn: (e: any) => void): () => void; emit(type: string, payload: unknown): unknown };
  mem: {
    append(sessionId: string, role: string, content: string, toolCallId?: string, parts?: unknown[] | null): void;
    working(sessionId: string): Array<{ role: string; content: unknown }>;
    recall(sessionId: string): Array<{ role: string; content: unknown }>;
    compactSmart(sessionId: string, summarize: (text: string) => Promise<string>): Promise<void>;
    recallHybrid?(query: string, opts?: { limit?: number; sessionId?: string }): Promise<Array<{ record: { id: string; content: unknown }; score?: number }>>;
  };
  config: { settings?: Record<string, unknown> };
  sessionId: string;
  cwd?: string;
  workspaceRoot: string;
  mode?: Mode;
  maxTurns?: number;
  systemPromptOverride?: string;
  excludeTools?: string[];
  toolLazyLoad?: boolean;
  backgroundNotify?: boolean;
  /** N1（批次ⅩⅩⅦ）：子代理实例标志——spawnSub 置位；durable 队列豁免等语义按标志判定（不猜 id 形态） */
  isSubagent?: boolean;
  /** N5（批次ⅩⅩⅧ）：懒加载模式下随实例激活的工具名（spawnSub 白名单传递——写入本实例激活集） */
  activateTools?: readonly string[];
  hooks?: Record<string, (...args: unknown[]) => unknown> | null;
  onToolTableUpdate?: (tools: unknown) => void;
  agentToolRunner?: unknown;
  approveForSession?: boolean;
  dataDir?: string;
}

export interface AgentRunOptions {
  images?: unknown[];
  goalLoop?: boolean;
  signal?: AbortSignal;
  runContext?: unknown;
  onCompactChoice?(info: { used: number; ctxLimit: number; compactAt: number }): Promise<'auto' | 'micro' | 'full' | 'none'>;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  turns: number;
  interrupted: boolean;
  status?: string;
}

// ═══ 常量（循环防护默认值——settings 可覆盖）═══
export const MAX_TURNS = 32;
export const RETRY_DELAY_MS = 800;
export const MAX_CONSECUTIVE_FAIL = 5;
export const MAX_UNKNOWN_TOOL_ROUNDS = 3;
export const LOOP_REMIND_AT = 2;
export const LOOP_HARD_STOP_AT = 5;
export const LOOP_SIG_WINDOW = 8;
export const CHANT_REMIND_AT = 3;
export const CHANT_STOP_AT = 5;
export const TOOL_CACHE_SIZE = 32;
export const FALLBACK_CTX_TOKENS = 66_000;
export const CORE_TOOL_NAMES = new Set(['fs_read', 'fs_write', 'fs_edit', 'bash', 'ls', 'grep', 'todo', 'clarify', 'ask_user', 'skill_load', 'tool_search', 'command_search']);
export const SUBAGENT_EXCLUDE = ['fs_write', 'fs_edit', 'bash', 'http_request', 'browser_navigate', 'browser_click', 'browser_type', 'apply_patch', 'scaffold_build', 'delegate', 'cron_create', 'wx_cmd', 'computer_click', 'computer_type', 'computer_open', 'computer_uia_click', 'computer_uia_type', 'computer_uia_act'];

// ═══ 纯函数 ═══

/** C3（2026-08-27）：工具参数 canonical 化——递归键序排序后序列化
 * 机制参考 kimi `_canonical_tool_arguments`（toolset.py:184-202，JSON 值排序；实现原创）。
 * 三个消费点（提前执行池 / 回合缓存 / 批内去重）共用同一 canonical 形态：
 * 同语义不同键序 → 同 key → 缓存命中（此前 miss 导致纯读工具重复执行）。
 * 循环检测签名也用同一形态（ⅩⅩⅦ 观察项收口——与缓存 key 口径一致）。
 */
const sortKeysDeep = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return v;
};

export const canonicalToolArgs = (args: unknown): string => {
  try {
    const sorted = sortKeysDeep(args);
    return JSON.stringify(sorted) ?? 'null';
  } catch {
    // 循环引用——诚实回退（键名排序序列化）
    try { return JSON.stringify(Object.keys(Object(args)).sort().map(k => String(k))); }
    catch { return '[]'; }
  }
};

/** 工具阶段一句话（A22 实时状态行——LLM 推理期 UI 可见） */
const TOOL_STAGE_VERBS: Record<string, string> = {
  fs_read: '读文件', fs_write: '写文件', fs_edit: '编辑文件', bash: '执行命令',
  ls: '列目录', grep: '搜内容', find_files: '找文件', http_get: 'GET', http_request: 'HTTP',
  web_search: '联网搜索', browser_navigate: '打开网页', browser_click: '点击网页', browser_type: '输入网页',
  browser_screenshot: '网页截图', browser_snapshot: '网页快照', browser_wait: '等元素', browser_close: '关浏览器',
  apply_patch: '应用补丁', delegate: '派子代理', todo: '待办', clarify: '向用户提问', ask_user: '询问用户',
  memory_search: '搜记忆', memory_write: '写记忆', memory_update: '改记忆', memory_delete: '删记忆',
  skill_load: '加载技能', repo_map: '读仓库地图', scaffold_build: '脚手架', notify: '通知',
  cron_create: '定时任务', wx_cmd: '内部命令', command_search: '搜命令', view_image: '看图',
  computer_screenshot: '截屏', computer_click: '点击屏幕', computer_type: '键入', computer_open: '打开',
  computer_observe: '观察屏幕', computer_uia_windows: 'UIA 窗口', computer_uia_tree: 'UIA 树',
  computer_uia_find: 'UIA 找元素', computer_uia_click: 'UIA 点击', computer_uia_type: 'UIA 输入',
  computer_uia_act: 'UIA 动作', lsp_diagnostics: 'LSP 诊断', lsp_hover: 'LSP 悬停', lsp_definition: 'LSP 定义',
};

export function toolStageBrief(name: string, args?: Record<string, unknown>): string {
  const verb = TOOL_STAGE_VERBS[name] ?? name;
  const brief = (['path', 'url', 'pattern', 'command', 'query', 'file', 'goal', 'content'] as const)
    .map(k => args?.[k])
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim().length < 60);
  return brief ? `${verb} ${brief.trim()}` : verb;
}
