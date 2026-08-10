// src/kernel/plugins.ts — 插件系统（P0：补齐对比缺口——参考 kimi plugin.json 机制，本地优先）
// 设计：
//   data/plugins/<name>/plugin.json 声明元数据与工具签名
//   data/plugins/<name>/index.js 实现（ESM/CJS 均可）导出 { tools, commands }
//   tools: Record<工具名, (args, ctx) => string|Promise<string>>
//   commands: Record<命令名, (args: string[]) => string|Promise<string>>
//   插件工具统一 danger:true（输出 untrusted 包裹，提示注入防护对插件同样生效）
//   插件命令注册为 /<插件名>.<命令名>（如 /example.hello），防与内置命令冲突
// 启用状态：plugin.json enabled 字段（/plugin enable|disable 修改，热生效）
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolDef } from './tools.js';

export interface PluginToolDecl {
  name: string;
  description: string;
  /** OpenAI 参数 schema 的 properties 部分 */
  parameters?: Record<string, any>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  tools?: PluginToolDecl[];
  /** 插件命令名（handler 在 index.js 的 commands 中实现） */
  commands?: string[];
}

export interface PluginToolCtx {
  cwd: string;
  dataDir: string;
  /** 读写插件自己的数据目录（data/plugins/<name>/data/） */
  dataPath: string;
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
        })).filter(t => t.name)
      : [],
    commands: Array.isArray(j.commands) ? j.commands.map(String).filter(Boolean) : [],
  };
}

// 加载单个插件目录（plugin.json + index.js）
export async function loadPlugin(dir: string, cwd: string, dataDir: string): Promise<LoadedPlugin | null> {
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
    mod = await import(pathToFileURL(indexFile).href + `?t=${Date.now()}`); // 时间戳防缓存
  } catch (e: any) {
    // 模块加载失败：返回空工具（/plugin list 可见状态）
    return { manifest, dir, tools: {}, commands: {} };
  }

  const handlers: Record<string, (args: any, ctx: PluginToolCtx) => unknown> = mod.tools ?? {};
  const cmds: Record<string, (args: string[]) => string | Promise<string>> = mod.commands ?? {};

  const dataPath = join(dir, 'data');
  const toolCtx: PluginToolCtx = { cwd, dataDir, dataPath };

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
      // 插件工具视为外部代码：输出统一 untrusted 包裹（提示注入防护）
      danger: true,
      run: async (args, ctx) => {
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
export async function loadAllPlugins(dataDir: string, cwd: string): Promise<LoadedPlugin[]> {
  const base = join(dataDir, 'plugins');
  if (!existsSync(base)) return [];
  let entries: string[] = [];
  try { entries = readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  const out: LoadedPlugin[] = [];
  for (const name of entries) {
    const p = await loadPlugin(join(base, name), cwd, dataDir);
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
