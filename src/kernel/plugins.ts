// src/kernel/plugins.ts — 插件系统（P0：补齐对比缺口——参考 kimi plugin.json 机制，本地优先）
// [ⅩⅩⅩⅢ Gap3 如实记录] Legacy 路径 in-process import 无技术隔离：
//   被信任插件拥有与宿主同权的 fs/网络。隔离依赖 trustedInProcessPlugins 白名单 + danger 确认门。
//   Modern 路径（processIsolationSandbox）有真实子进程隔离但尚未成为缺省。设计限制非 bug。
// 设计：
//   data/plugins/<name>/plugin.json 声明元数据与工具签名
//   data/plugins/<name>/index.js 实现（ESM/CJS 均可）导出 { tools, commands }
//   tools: Record<工具名, (args, ctx) => string|Promise<string>>
//   commands: Record<命令名, (args: string[]) => string|Promise<string>>（仅发现；原始函数禁止直连 CommandBus）
//   插件工具统一 danger:true（输出 untrusted 包裹，提示注入防护对插件同样生效）
//   插件命令名保留在帮助/补全中，但在声明式 tool 映射落地前 fail-closed
// 启用状态：plugin.json enabled 字段（/plugin enable|disable 修改，热生效）
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolDef } from './tools.js';
import { commandCompletion, type CommandBus } from '../app/CommandBus.js';
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
  /** ⅩⅩⅩⅤ 权限作用域：插件可访问的 fs 路径前缀（缺省仅 dataPath；声明后加白） */
  allowedPaths?: readonly string[];
  /** ⅩⅩⅩⅤ 网络作用域：插件可访问的域名白名单（缺省拒绝全部——空数组=完全离线） */
  allowedDomains?: readonly string[];
  /** ⅩⅩⅩⅤ 网络代理 fetch：经 allowedDomains 白名单校验后的受控网络访问
   *  （不经此通道的 require('node:http') 等不受限——legacy in-process 的已知限制，
   *   modern 子进程沙盒有 OS 级阻断；本接口是「最佳实践通道」而非强制门） */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Record<string, ToolDef>;
  commands: Record<string, (args: string[]) => string | Promise<string>>;
  /** 候选加载阶段不订阅生产事件；发布后由 runtime owner 激活。 */
  activate(): Promise<void>;
  /** 释放 onLoad 清理器与插件通过 ctx.on 建立的全部订阅。 */
  dispose(): Promise<void>;
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
}

export interface PluginLoadOptions {
  on?: PluginToolCtx['on'];
  getConfig?: PluginToolCtx['getConfig'];
  /** Host-owned allowlist. A manifest can never declare itself trusted for in-process execution. */
  trustedInProcessPlugins?: readonly string[];
}

const inertLifecycle = () => ({ async activate() {}, async dispose() {} });

function assertPackageIdentity(dir: string, manifest: PluginManifest): void {
  const packageName = dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (packageName !== manifest.name) {
    throw new Error(`plugin package identity mismatch: directory ${packageName} != manifest ${manifest.name}`);
  }
}

function assertTrustedInProcess(manifest: PluginManifest, options?: PluginLoadOptions): void {
  if (!options?.trustedInProcessPlugins?.includes(manifest.name)) {
    throw new Error(`plugin ${manifest.name} is not permitted by trusted in-process policy`);
  }
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
          demo: t?.demo === true,
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

// Discover plugin metadata only. This path never evaluates index.js.
export function discoverPlugins(dataDir: string): DiscoveredPlugin[] {
  const base = join(dataDir, 'plugins');
  if (!existsSync(base)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch {
    return [];
  }

  const discovered: DiscoveredPlugin[] = [];
  for (const name of entries) {
    const dir = join(base, name);
    const manifestFile = join(dir, 'plugin.json');
    const indexFile = join(dir, 'index.js');
    if (!existsSync(manifestFile) || !existsSync(indexFile)) continue;
    try {
      const manifest = parsePluginManifest(readFileSync(manifestFile, 'utf8'));
      assertPackageIdentity(dir, manifest);
      discovered.push({ manifest, dir });
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('package identity mismatch')) throw cause;
      discovered.push({
        manifest: { name: `broken-${name}`, version: '0', enabled: false },
        dir,
      });
    }
  }
  return discovered;
}

// 加载单个插件目录（plugin.json + index.js）
export async function loadPlugin(dir: string, cwd: string, dataDir: string, extra?: PluginLoadOptions): Promise<LoadedPlugin | null> {
  const manifestFile = join(dir, 'plugin.json');
  const indexFile = join(dir, 'index.js');
  if (!existsSync(manifestFile) || !existsSync(indexFile)) return null;

  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(readFileSync(manifestFile, 'utf8'));
    assertPackageIdentity(dir, manifest);
  } catch (e: any) {
    if (e instanceof Error && e.message.includes('package identity mismatch')) throw e;
    // 清单损坏：不阻断其他插件
    manifest = { name: `broken-${Date.now().toString(36)}`, version: '0', enabled: false };
  }
  if (!manifest.enabled) return { manifest, dir, tools: {}, commands: {}, ...inertLifecycle() };
  assertTrustedInProcess(manifest, extra);

  let mod: any = {};
  try {
    // 运行时动态 file URL + 时间戳防缓存。CI 失败根因=runner 的 D:\a\_temp 是 junction
    // （vite 模块运行器 realpath 与词法路径不一致拒载，2026-08-18 七轮取证）——由 CI 门禁
    // 步骤 TMP/TEMP 覆盖到工作区真实目录系统性解决；此处保持原生 import 语义。
    mod = await import(pathToFileURL(indexFile).href + `?t=${Date.now()}`); // 时间戳防缓存
  } catch (e: any) {
    // 模块加载失败：返回空工具（/plugin list 可见状态）
    return { manifest, dir, tools: {}, commands: {}, ...inertLifecycle() };
  }

  const handlers: Record<string, (args: any, ctx: PluginToolCtx) => unknown> = mod.tools ?? {};
  const cmds: Record<string, (args: string[]) => string | Promise<string>> = mod.commands ?? {};

  const dataPath = join(dir, 'data');
  const logFile = join(dataPath, 'plugin.log');
  const subscriptions = new Set<{ type: string; cb: (payload: any) => void; off?: () => void }>();
  let active = false;
  let disposed = false;
  let cleanup: (() => void | Promise<void>) | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const detach = (subscription: { off?: () => void }): void => {
    const off = subscription.off;
    subscription.off = undefined;
    try { off?.(); } catch { /* 插件清理失败不阻断 runtime 切换 */ }
  };
  const toolCtx: PluginToolCtx = {
    cwd, dataDir, dataPath,
    on: (type, cb) => {
      if (disposed) return () => {};
      const subscription: { type: string; cb: (payload: any) => void; off?: () => void } = { type, cb };
      subscriptions.add(subscription);
      if (active && !disposed && extra?.on) subscription.off = extra.on(type, cb);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        detach(subscription);
        subscriptions.delete(subscription);
      };
    },
    getConfig: extra?.getConfig,
    log: (level, msg) => {
      try {
        mkdirSync(dataPath, { recursive: true });
        appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${msg}
`);
      } catch { /* 日志失败静默 */ }
    },
  };

  // onLoad 可在候选阶段完成纯初始化并登记事件，但 ctx.on 只暂存订阅；activate 后才接入生产总线。
  const onLoadResult = typeof mod.onLoad === 'function'
    ? Promise.resolve().then(() => mod.onLoad(toolCtx)).catch(() => undefined)
    : Promise.resolve(undefined);

  const runCleanup = async (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const result = await onLoadResult;
      cleanup = typeof result === 'function' ? result : undefined;
      const fn = cleanup;
      cleanup = undefined;
      try { await fn?.(); } catch { /* 插件清理失败不阻断 runtime 切换 */ }
    })();
    return cleanupPromise;
  };

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
      canonical: { namespace: 'plugin', source: manifest.name },
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

  const lifecycle = {
    async activate(): Promise<void> {
      if (active || disposed) return;
      await onLoadResult;
      if (disposed) return;
      active = true;
      try {
        if (extra?.on) {
          for (const subscription of subscriptions) {
            if (!subscription.off) subscription.off = extra.on(subscription.type, subscription.cb);
          }
        }
      } catch (cause) {
        active = false;
        for (const subscription of subscriptions) detach(subscription);
        throw cause;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      active = false;
      for (const subscription of subscriptions) detach(subscription);
      subscriptions.clear();
      await runCleanup();
    },
  };

  return { manifest, dir, tools, commands: cmds, ...lifecycle };
}

// 发现全部插件（metadata scan first; only explicitly trusted packages may execute in-process）
export async function loadAllPlugins(dataDir: string, cwd: string, extra?: PluginLoadOptions): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  for (const discovered of discoverPlugins(dataDir)) {
    if (discovered.manifest.enabled === false || !extra?.trustedInProcessPlugins?.includes(discovered.manifest.name)) {
      out.push({ ...discovered, tools: {}, commands: {}, ...inertLifecycle() });
      continue;
    }
    const plugin = await loadPlugin(discovered.dir, cwd, dataDir, extra);
    if (plugin) out.push(plugin);
  }
  return out;
}

// 插件工具合并为 extraTools（供 cli 装配 agent）
export function pluginToolsToExtra(plugins: LoadedPlugin[]): Record<string, ToolDef> {
  const out: Record<string, ToolDef> = {};
  const owner = new Map<string, string>();
  for (const plugin of [...plugins].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, 'en'))) {
    for (const name of Object.keys(plugin.tools).sort((left, right) => left.localeCompare(right, 'en'))) {
      const previous = owner.get(name);
      if (previous) throw new Error(`plugin tool collision: ${name} declared by ${previous} and ${plugin.manifest.name}`);
      const tool = plugin.tools[name]!;
      if (tool.canonical?.namespace !== 'plugin' || tool.canonical.source !== plugin.manifest.name) {
        throw new Error(`plugin tool namespace mismatch: ${plugin.manifest.name}.${name}`);
      }
      owner.set(name, plugin.manifest.name);
      out[name] = tool;
    }
  }
  return out;
}

// 写入插件清单（/plugin enable|disable 修改 enabled 字段）
export function setPluginEnabled(dir: string, enabled: boolean): boolean {
  const file = join(dir, 'plugin.json');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const manifest = parsePluginManifest(JSON.stringify(raw));
    assertPackageIdentity(dir, manifest);
    raw.enabled = enabled;
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

// ── 插件命令注册：原始同进程函数不能绕过 canonical pipeline。──
// 每个 CommandBus 只有一个插件命令快照；替换时旧 handler 与帮助/补全元数据同步移除。
interface PluginCommandRegistration {
  commands: Set<string>;
  dispose(): void;
}

const registeredPluginCommands = new WeakMap<CommandBus, PluginCommandRegistration>();

export function registerPluginCommands(bus: CommandBus, plugins: LoadedPlugin[]): () => void {
  const previous = registeredPluginCommands.get(bus);
  const declared = new Map<string, string>();
  for (const p of plugins) {
    for (const cmdName of Object.keys(p.commands)) {
      const full = `/${p.manifest.name}.${cmdName}`;
      if (declared.has(full)) throw new Error(`插件命令冲突：${full}`);
      declared.set(full, p.manifest.name);
    }
  }

  const occupied = new Set(bus.list());
  for (const command of previous?.commands ?? []) occupied.delete(command);
  for (const command of declared.keys()) {
    if (occupied.has(command)) throw new Error(`插件命令与现有命令冲突：${command}`);
  }

  previous?.dispose();
  const commands = new Set(declared.keys());
  let disposed = false;
  const registration: PluginCommandRegistration = {
    commands,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const command of commands) {
        bus.unregister(command);
        const index = SLASH.indexOf(command);
        if (index >= 0) SLASH.splice(index, 1);
        delete COMMAND_DESC[command];
      }
      if (registeredPluginCommands.get(bus) === registration) {
        registeredPluginCommands.delete(bus);
      }
    },
  };

  for (const [full, pluginName] of declared) {
    bus.register(full, () => commandCompletion(
      `插件命令 ${full} 未执行：原始插件函数尚未接入 canonical tool pipeline，请使用该插件声明的工具`,
      'blocked',
    ));
    SLASH.push(full);
    COMMAND_DESC[full] = `插件命令（${pluginName}，当前阻止直接执行）`;
  }
  registeredPluginCommands.set(bus, registration);
  return () => registration.dispose();
}

// 插件 NL 触发同样使用单一快照，禁用、移除或 reload 后旧正则立即失效。
let registeredPluginNlTriggers: { dispose(): void } | undefined;

export function registerPluginNlTriggers(plugins: LoadedPlugin[]): () => void {
  const triggers: Array<{ re: RegExp; cmd: string }> = [];
  for (const p of plugins) {
    for (const trigger of p.manifest.nlTriggers ?? []) {
      try { triggers.push({ re: new RegExp(trigger.re), cmd: trigger.cmd }); }
      catch { /* 非法正则跳过（不阻断插件加载） */ }
    }
  }

  registeredPluginNlTriggers?.dispose();
  const disposers = triggers.map(trigger => registerNlTrigger(trigger.re, trigger.cmd));
  let disposed = false;
  const registration = {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers) dispose();
      if (registeredPluginNlTriggers === registration) registeredPluginNlTriggers = undefined;
    },
  };
  registeredPluginNlTriggers = registration;
  return () => registration.dispose();
}
