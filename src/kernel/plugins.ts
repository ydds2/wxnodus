// src/kernel/plugins.ts — 插件系统（P0：补齐对比缺口——参考 kimi plugin.json 机制，本地优先）
// 设计：
//   data/plugins/<name>/plugin.json 声明元数据与工具签名
//   data/plugins/<name>/index.js 实现（ESM/CJS 均可）导出 { tools, commands }
//   tools: Record<工具名, (args, ctx) => string|Promise<string>>
//   commands: Record<命令名, (args: string[]) => string|Promise<string>>
//   插件工具统一 danger:true（输出 untrusted 包裹，提示注入防护对插件同样生效）
//   插件命令注册为 /<插件名>.<命令名>（如 /example.hello），防与内置命令冲突
// 启用状态：plugin.json enabled 字段（/plugin enable|disable 修改，热生效）
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolDef } from './tools.js';
import type { CommandBus } from '../app/CommandBus.js';
import { SLASH, COMMAND_DESC } from '../commands/registry.js';
import { registerNlTrigger } from '../commands/intent.js';

export interface PluginToolDecl {
  name: string;
  description?: string;
  /** OpenAI 参数 schema 的 properties 部分 */
  parameters?: Record<string, any>;
  /** 危险声明（开放兼容）：缺省 true（插件视为外部代码），声明 false 则
   *  只读语义（smart/manual/plan 下不再恒需确认） */
  danger?: boolean;
  /** 演示标记（/plugin new 脚手架工具自带）：demo 工具对模型隐藏（模型不注入
   *  schema、不可调用）——示例插件工具曾对「hello」这类闲聊被廉价模型选中，
   *  触发审批面板阻塞会话（真实 cmd 实测）；人工仍可经插件命令使用 */
  demo?: boolean;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  tools?: PluginToolDecl[];
  /** 插件命令名（handler 在 index.js 的 commands 中实现） */
  commands?: string[];
  /** 自然语言触发注册（开放兼容）：{ re: 正则字符串, cmd: 命令名 }——加载后进意图路由 */
  nlTriggers?: Array<{ re: string; cmd: string }>;
}

export interface PluginToolCtx {
  cwd: string;
  dataDir: string;
  /** 读写插件自己的数据目录（data/plugins/<name>/data/） */
  dataPath: string;
  /** 事件订阅：on(type, cb) 订阅系统事件（agent.token/system.notice/agent.tool 等），
   *  返回取消函数。事件面与 hooks 一致（12 类 + 消息流事件） */
  on?: (type: string, cb: (payload: any) => void) => () => void;
  /** 查询当前配置（只读）：getConfig(partition, key?) */
  getConfig?: (partition: string, key?: string) => any;
  /** 插件日志：log(level, msg) → data/plugins/<name>/plugin.log 追加 */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Record<string, ToolDef>;
  commands: Record<string, (args: string[]) => string | Promise<string>>;
}

// 解析 plugin.json（手写，无 YAML 依赖——同 skills frontmatter 思路）
export function parsePluginManifest(raw: string): PluginManifest {
  const j = JSON.parse(raw) as Record<string, any>;
  const name = String(j.name ?? '').trim();
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('插件名非法（仅字母/数字/_/-）');
  return {
    name,
    version: String(j.version ?? '0.0.1'),
    description: String(j.description ?? ''),
    enabled: j.enabled !== false,
    tools: Array.isArray(j.tools)
      ? j.tools.map((t: any) => ({
          name: String(t?.name ?? '').trim(),
          description: String(t?.description ?? ''),
          parameters: t?.parameters ?? {},
          danger: t?.danger !== false,
        })).filter(t => t.name)
      : [],
    commands: Array.isArray(j.commands) ? j.commands.map(String).filter(Boolean) : [],
    nlTriggers: Array.isArray(j.nlTriggers)
      ? j.nlTriggers.map((t: any) => ({
          re: String(t?.re ?? ''),
          cmd: String(t?.cmd ?? '').trim(),
        })).filter(t => t.re && t.cmd)
      : [],
  };
}

// 加载单个插件目录（plugin.json + index.js）
export async function loadPlugin(dir: string, cwd: string, dataDir: string, extra?: { on?: PluginToolCtx['on']; getConfig?: PluginToolCtx['getConfig'] }): Promise<LoadedPlugin | null> {
  const manifestFile = join(dir, 'plugin.json');
  const indexFile = join(dir, 'index.js');
  if (!existsSync(manifestFile) || !existsSync(indexFile)) return null;

  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(readFileSync(manifestFile, 'utf8'));
  } catch (e: any) {
    // 清单损坏：不阻断其他插件
    manifest = { name: `broken-${Date.now().toString(36)}`, version: '0', enabled: false };
  }
  if (!manifest.enabled) return { manifest, dir, tools: {}, commands: {} };

  let mod: any = {};
  try {
    // 运行时动态 file URL + 时间戳防缓存。CI 失败根因=runner 的 D:\a\_temp 是 junction
    // （vite 模块运行器 realpath 与词法路径不一致拒载，2026-08-18 七轮取证）——由 CI 门禁
    // 步骤 TMP/TEMP 覆盖到工作区真实目录系统性解决；此处保持原生 import 语义。
    mod = await import(pathToFileURL(indexFile).href + `?t=${Date.now()}`); // 时间戳防缓存
  } catch (e: any) {
    // 模块加载失败：返回空工具（/plugin list 可见状态）
    return { manifest, dir, tools: {}, commands: {} };
  }

  const handlers: Record<string, (args: any, ctx: PluginToolCtx) => unknown> = mod.tools ?? {};
  const cmds: Record<string, (args: string[]) => string | Promise<string>> = mod.commands ?? {};

  const dataPath = join(dir, 'data');
  const logFile = join(dataPath, 'plugin.log');
  const toolCtx: PluginToolCtx = {
    cwd, dataDir, dataPath,
    on: extra?.on,
    getConfig: extra?.getConfig,
    log: (level, msg) => {
      try {
        mkdirSync(dataPath, { recursive: true });
        appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${msg}
`);
      } catch { /* 日志失败静默 */ }
    },
  };

  // onLoad 生命周期（docs/plugin-api.md 已声明——真正实现）：
  // 模块导出 onLoad(ctx) 时调用（可做初始化/注册清理器）；异常不阻断加载
  if (typeof mod.onLoad === 'function') {
    try { mod.onLoad(toolCtx); } catch { /* onLoad 异常静默（加载继续） */ }
  }

  const tools: Record<string, ToolDef> = {};
  for (const decl of manifest.tools ?? []) {
    const name = decl.name;
    const handler = handlers[name];
    if (!handler) continue; // 声明了但未实现：跳过
    tools[name] = {
      schema: {
        type: 'function',
        function: {
          name,
          description: decl.description || `插件工具（${manifest.name}）`,
          parameters: { type: 'object', properties: decl.parameters ?? {}, required: [] },
        },
      },
      // 演示工具标记透传（agent 侧对模型隐藏，见 agent.ts DEMO_TOOL_RE/includeDemoTools）
      demo: decl.demo === true,
      // 插件工具默认视为外部代码（输出 untrusted 包裹，提示注入防护）；
      // 开放兼容：manifest 声明 danger:false 的插件工具获得只读语义
      danger: decl.danger !== false,
      run: async (args) => {
        try {
          const out = await handler(args, toolCtx);
          return String(out ?? '');
        } catch (e: any) {
          return `插件工具执行异常：${e?.message?.slice(0, 300) ?? e}`;
        }
      },
    };
  }

  return { manifest, dir, tools, commands: cmds };
}

// 发现全部插件（data/plugins/*/ 含 plugin.json 的目录）
export async function loadAllPlugins(dataDir: string, cwd: string, extra?: { on?: PluginToolCtx['on']; getConfig?: PluginToolCtx['getConfig'] }): Promise<LoadedPlugin[]> {
  const base = join(dataDir, 'plugins');
  if (!existsSync(base)) return [];
  let entries: string[] = [];
  try { entries = readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  const out: LoadedPlugin[] = [];
  for (const name of entries) {
    const p = await loadPlugin(join(base, name), cwd, dataDir, extra);
    if (p) out.push(p);
  }
  return out;
}

// 插件工具合并为 extraTools（供 cli 装配 agent）
export function pluginToolsToExtra(plugins: LoadedPlugin[]): Record<string, ToolDef> {
  const out: Record<string, ToolDef> = {};
  for (const p of plugins) {
    for (const [name, tool] of Object.entries(p.tools)) {
      out[name] = tool;
    }
  }
  return out;
}

// 写入插件清单（/plugin enable|disable 修改 enabled 字段）
export function setPluginEnabled(dir: string, enabled: boolean): boolean {
  const file = join(dir, 'plugin.json');
  try {
    const m = parsePluginManifest(readFileSync(file, 'utf8'));
    m.enabled = enabled;
    writeFileSync(file, JSON.stringify({ ...m, enabled }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

// ── 插件命令注册（开放兼容：启动与 /plugin reload 共用；bus.register 同名覆盖 = 热更新）──
export function registerPluginCommands(bus: CommandBus, plugins: LoadedPlugin[]): void {
  for (const p of plugins) {
    for (const [cmdName, fn] of Object.entries(p.commands)) {
      const full = `/${p.manifest.name}.${cmdName}`;
      bus.register(full, (args) => Promise.resolve(fn(args)));
      if (!SLASH.includes(full)) {
        SLASH.push(full);
        COMMAND_DESC[full] = `插件命令（${p.manifest.name}）`;
      }
    }
  }
}

// 插件 NL 触发注册（开放兼容）：manifest.nlTriggers 进意图路由（运行时生效）
// reload 时重复注册无害（routeNaturalLanguage 首个命中即返回）
export function registerPluginNlTriggers(plugins: LoadedPlugin[]): void {
  for (const p of plugins) {
    for (const t of p.manifest.nlTriggers ?? []) {
      try {
        registerNlTrigger(new RegExp(t.re), t.cmd);
      } catch { /* 非法正则跳过（不阻断插件加载） */ }
    }
  }
}
