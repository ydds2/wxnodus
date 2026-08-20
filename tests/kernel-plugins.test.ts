// tests/kernel-plugins.test.ts — 插件系统：发现/加载/工具构建/命令/启停
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins, loadAllPlugins, loadPlugin, parsePluginManifest, pluginToolsToExtra, registerPluginCommands, registerPluginNlTriggers, setPluginEnabled, type LoadedPlugin } from '../src/kernel/plugins.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { registerNlTrigger, routeNaturalLanguage } from '../src/commands/intent.js';
import { COMMAND_DESC, SLASH } from '../src/commands/registry.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-plug-'));
  // 插件 A：工具 + 命令
  const a = join(dir, 'plugins', 'alpha');
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, 'plugin.json'), JSON.stringify({
    name: 'alpha',
    version: '1.0.0',
    description: '测试插件',
    tools: [{ name: 'alpha_hello', description: '打招呼', parameters: { name: { type: 'string' } } }],
    commands: ['hello'],
  }));
  writeFileSync(join(a, 'index.js'), `
export const tools = {
  alpha_hello: async (args, ctx) => '你好，' + String(args?.name ?? '世界') + '（dataPath=' + ctx.dataPath + '）',
};
export const commands = {
  hello: async (args) => '插件命令收到：' + args.join(' '),
};
`);
  // 插件 B：禁用状态（不应加载工具）
  const b = join(dir, 'plugins', 'beta');
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, 'plugin.json'), JSON.stringify({ name: 'beta', version: '0.1.0', enabled: false, tools: [{ name: 'beta_tool', description: 'x' }] }));
  writeFileSync(join(b, 'index.js'), `export const tools = { beta_tool: async () => '不应被调用' };`);
  // 插件 C：损坏清单（不应阻断其他插件）
  const c = join(dir, 'plugins', 'gamma');
  mkdirSync(c, { recursive: true });
  writeFileSync(join(c, 'plugin.json'), '{{ 损坏 JSON');
  writeFileSync(join(c, 'index.js'), `export const tools = {};`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('插件清单解析', () => {
  it('正常清单解析工具/命令/enabled/demo', () => {
    const m = parsePluginManifest(JSON.stringify({ name: 'x', version: '2', tools: [{ name: 't1', description: 'd', demo: true }], commands: ['c1'] }));
    expect(m.name).toBe('x');
    expect(m.tools?.[0]?.name).toBe('t1');
    expect(m.tools?.[0]?.demo).toBe(true);
    expect(m.commands).toEqual(['c1']);
    expect(m.enabled).toBe(true);
  });
  it('enabled:false 与非法名', () => {
    expect(parsePluginManifest(JSON.stringify({ name: 'y', enabled: false })).enabled).toBe(false);
    expect(() => parsePluginManifest(JSON.stringify({ name: '坏 名' }))).toThrow();
  });
});

describe('插件发现与加载', () => {
  it('discovery reads metadata without importing plugin code', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-pl-discover-'));
    const marker = `__wxPluginDiscovery_${Date.now()}`;
    try {
      const pluginDir = join(d, 'plugins', 'metadata-only');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'metadata-only', version: '1.0.0' }));
      writeFileSync(join(pluginDir, 'index.js'), `globalThis.${marker} = true; export const tools = {};`);

      const discovered = discoverPlugins(d);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toMatchObject({ manifest: { name: 'metadata-only' }, dir: pluginDir });
      expect((globalThis as any)[marker]).toBeUndefined();
    } finally {
      delete (globalThis as any)[marker];
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('dynamic import requires explicit trusted in-process policy', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-pl-trust-'));
    const marker = `__wxPluginTrustedImport_${Date.now()}`;
    try {
      const pluginDir = join(d, 'plugins', 'trusted-only');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'trusted-only', version: '1.0.0' }));
      writeFileSync(join(pluginDir, 'index.js'), `globalThis.${marker} = (globalThis.${marker} ?? 0) + 1; export const tools = {};`);

      await expect(loadPlugin(pluginDir, d, d)).rejects.toThrow(/trusted in-process policy/i);
      expect((globalThis as any)[marker]).toBeUndefined();

      const loaded = await loadPlugin(pluginDir, d, d, { trustedInProcessPlugins: ['trusted-only'] });
      expect(loaded?.manifest.name).toBe('trusted-only');
      expect((globalThis as any)[marker]).toBe(1);
    } finally {
      delete (globalThis as any)[marker];
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('rejects manifest identity that differs from the package directory', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-pl-identity-'));
    try {
      const pluginDir = join(d, 'plugins', 'package-name');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'different-name', version: '1.0.0' }));
      writeFileSync(join(pluginDir, 'index.js'), 'export const tools = {};');

      expect(() => discoverPlugins(d)).toThrow(/identity/i);
      await expect(loadPlugin(pluginDir, d, d, { trustedInProcessPlugins: ['different-name'] })).rejects.toThrow(/identity/i);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('enable toggles preserve unknown manifest fields exactly', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-pl-preserve-'));
    try {
      const pluginDir = join(d, 'preserve');
      mkdirSync(pluginDir, { recursive: true });
      const manifest = {
        name: 'preserve', version: '1.2.3', enabled: true,
        customPolicy: { issuer: 'local-admin', flags: ['a', 'b'] },
        tools: [{ name: 'preserve_tool', customToolField: { mode: 'strict' } }],
      };
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

      expect(setPluginEnabled(pluginDir, false)).toBe(true);
      expect(JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'))).toEqual({ ...manifest, enabled: false });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('plugin tool namespaces and collisions are deterministic and fail closed', () => {
    const makePlugin = (name: string, toolName: string): LoadedPlugin => ({
      manifest: { name, version: '1.0.0' }, dir: name,
      tools: { [toolName]: { schema: { type: 'function' as const, function: { name: toolName, description: '', parameters: { type: 'object', properties: {} } } }, danger: true, canonical: { namespace: 'plugin', source: name }, run: async () => name } },
      commands: {}, async activate() {}, async dispose() {},
    });
    const alpha = makePlugin('alpha', 'shared');
    const beta = makePlugin('beta', 'shared');

    expect(Object.keys(pluginToolsToExtra([makePlugin('zeta', 'z_tool'), makePlugin('alpha', 'a_tool')]))).toEqual(['a_tool', 'z_tool']);
    expect(() => pluginToolsToExtra([alpha, beta])).toThrow(/collision.*shared/i);
  });

  it('loads all plugins only when each package is explicitly trusted', async () => {
    const plugins = await loadAllPlugins(dir, process.cwd(), { trustedInProcessPlugins: ['alpha', 'delta'] });
    expect(plugins.find(p => p.manifest.name === 'alpha')?.tools.alpha_hello).toBeDefined();
    expect(plugins.find(p => p.manifest.name === 'beta')?.tools).toEqual({});
  });

  it('加载全部插件：工具构建 + 命令加载 + 禁用跳过', async () => {
    const plugins = await loadAllPlugins(dir, process.cwd(), { trustedInProcessPlugins: ['alpha'] });
    expect(plugins.length).toBe(3); // alpha/beta(禁用)/gamma(损坏)

    const alpha = plugins.find(p => p.manifest.name === 'alpha')!;
    expect(alpha.manifest.enabled).toBe(true);
    // 工具构建为 ToolDef（danger:true + schema）
    const tool = alpha.tools['alpha_hello']!;
    expect(tool.danger).toBe(true);
    expect(tool.schema.function.name).toBe('alpha_hello');
    const out = await tool.run({ name: 'wxnodus' }, { cwd: process.cwd(), dataDir: dir });
    expect(out).toContain('你好，wxnodus');
    // 命令加载
    expect(typeof alpha.commands['hello']).toBe('function');
    expect(await alpha.commands['hello']!(['测试'])).toContain('测试');

    // 禁用插件：无工具
    const beta = plugins.find(p => p.manifest.name === 'beta')!;
    expect(Object.keys(beta.tools).length).toBe(0);

    // 损坏清单：不阻断（broken 名 + 空工具）
    const gamma = plugins.find(p => p.manifest.name.startsWith('broken'))!;
    expect(gamma).toBeDefined();
    expect(Object.keys(gamma.tools).length).toBe(0);
  });

  it('声明未实现的工具跳过', async () => {
    const d = join(dir, 'plugins', 'delta');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name: 'delta', tools: [{ name: 'unimpl', description: 'x' }] }));
    writeFileSync(join(d, 'index.js'), `export const tools = {};`);
    const p = await loadPlugin(d, process.cwd(), dir, { trustedInProcessPlugins: ['delta'] });
    expect(p).not.toBeNull();
    expect(Object.keys(p!.tools).length).toBe(0); // 声明了但未实现 → 跳过
  });

  it('CommandBus fail-closed：插件原始命令函数不得直接执行', async () => {
    const plugins = await loadAllPlugins(dir, process.cwd(), { trustedInProcessPlugins: ['alpha'] });
    const alpha = plugins.find(p => p.manifest.name === 'alpha')!;
    let rawCalls = 0;
    alpha.commands.hello = async () => { rawCalls++; return '不应返回'; };
    const bus = createCommandBus();

    const dispose = registerPluginCommands(bus, [alpha]);
    const result = await bus.execute('/alpha.hello 测试');

    expect(rawCalls).toBe(0);
    expect(result).toMatchObject({ ok: false, completionStatus: 'blocked' });
    expect(result.output).toContain('未执行');
    dispose();
  });

  it('插件命令快照替换同步清理执行表与帮助/补全元数据', async () => {
    const plugins = await loadAllPlugins(dir, process.cwd(), { trustedInProcessPlugins: ['alpha'] });
    const alpha = plugins.find(p => p.manifest.name === 'alpha')!;
    const bus = createCommandBus();

    const disposeOld = registerPluginCommands(bus, [alpha]);
    expect(bus.list()).toContain('/alpha.hello');
    expect(SLASH).toContain('/alpha.hello');
    expect(COMMAND_DESC['/alpha.hello']).toContain('alpha');

    const disposeEmpty = registerPluginCommands(bus, []);
    expect(bus.list()).not.toContain('/alpha.hello');
    expect(SLASH).not.toContain('/alpha.hello');
    expect(COMMAND_DESC['/alpha.hello']).toBeUndefined();
    expect(await bus.execute('/alpha.hello')).toMatchObject({ ok: false, completionStatus: 'failed' });

    disposeOld();
    disposeEmpty();
  });

  it('enable/disable 修改清单持久化', async () => {
    const d = join(dir, 'plugins', 'alpha');
    expect(setPluginEnabled(d, false)).toBe(true);
    const p = await loadPlugin(d, process.cwd(), dir);
    expect(p!.manifest.enabled).toBe(false);
    expect(Object.keys(p!.tools).length).toBe(0);
    expect(setPluginEnabled(d, true)).toBe(true);
  });
});

// ── P3b：清单边界与容错 ──
describe('清单边界', () => {
  it('缺 name 抛错', () => {
    expect(() => parsePluginManifest('{}')).toThrow();
    expect(() => parsePluginManifest('')).toThrow();
  });
  it('缺 tools/commands 默认空数组', () => {
    const m = parsePluginManifest(JSON.stringify({ name: 'min' }));
    expect(m.tools).toEqual([]);
    expect(m.commands).toEqual([]);
  });
  it('name 含路径分隔符拒绝', () => {
    expect(() => parsePluginManifest(JSON.stringify({ name: '../evil' }))).toThrow();
    expect(() => parsePluginManifest(JSON.stringify({ name: 'a\\b' }))).toThrow();
  });
  it('加载不存在的目录返回 null', async () => {
    expect(await loadPlugin(join(dir, 'nope'), process.cwd(), dir)).toBeNull();
  });
  it('损坏 index.js 降级为空工具插件（不抛）', async () => {
    const d = join(dir, 'plugins', 'epsilon');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name: 'epsilon', tools: [{ name: 't', description: 'x' }] }));
    writeFileSync(join(d, 'index.js'), 'export const 语法错误 = ;;;');
    const p = await loadPlugin(d, process.cwd(), dir, { trustedInProcessPlugins: ['epsilon'] });
    expect(p).not.toBeNull();
    expect(Object.keys(p!.tools).length).toBe(0);
  });
  it('setPluginEnabled 不存在目录返回 false', () => {
    expect(setPluginEnabled(join(dir, 'ghost'), false)).toBe(false);
  });
});

// ── 阶段 3：插件 API 层——事件订阅/配置访问/日志 ──
describe('插件 API 开放层', () => {
  it('ctx.on 事件订阅、ctx.getConfig、ctx.log 真实注入', async () => {
    const { loadPlugin } = await import('../src/kernel/plugins.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-pl2-'));
    try {
      const dir = join(d, 'plugins', 'api');
      mkdirSync(join(dir, 'data'), { recursive: true });
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'api', description: 'API 测试', version: '1.0.0', enabled: true, tools: [{ name: 'api_probe', description: '探测', parameters: { type: 'object', properties: {} } }] }));
      writeFileSync(join(dir, 'index.js'), `
        export const tools = {
          api_probe: async (_args, ctx) => {
            const got = ctx.on('system.notice', () => {});
            const model = ctx.getConfig('settings', 'model') ?? 'none';
            ctx.log('info', 'probe');
            return 'on:' + typeof got + '|model:' + model;
          },
        };
      `);
      const captured: Array<{ type: string; payload: any }> = [];
      const plugin = await loadPlugin(dir, d, join(d, 'data'), {
        on: (type, cb) => { captured.push({ type, payload: null }); return () => {}; },
        getConfig: (p, k) => (p === 'settings' && k === 'model' ? 'test-model' : undefined),
        trustedInProcessPlugins: ['api'],
      });
      expect(plugin).not.toBeNull();
      const tool = plugin!.tools['api_probe']!;
      const out = await tool.run({}, { cwd: d } as any);
      expect(out).toBe('on:function|model:test-model');
      // 日志文件真实写入
      const log = readFileSync(join(dir, 'data', 'plugin.log'), 'utf8');
      expect(log).toContain('[info] probe');
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('候选订阅延迟到 activate，dispose 幂等释放订阅与 onLoad 清理器', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-pl-life-'));
    const marker = `__wxPluginCleanup_${Date.now()}`;
    try {
      const pluginDir = join(d, 'plugins', 'life');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'life', version: '1.0.0' }));
      writeFileSync(join(pluginDir, 'index.js'), `
        export async function onLoad(ctx) {
          await Promise.resolve();
          ctx.on('system.notice', () => {});
          return () => { globalThis.${marker} = (globalThis.${marker} ?? 0) + 1; };
        }
      `);
      let attached = 0;
      let detached = 0;
      const plugin = await loadPlugin(pluginDir, d, d, {
        trustedInProcessPlugins: ['life'],
        on: () => {
          attached++;
          let done = false;
          return () => { if (!done) { done = true; detached++; } };
        },
      });

      expect(plugin).not.toBeNull();
      expect(attached).toBe(0);
      await plugin!.activate();
      await plugin!.activate();
      expect(attached).toBe(1);

      await plugin!.dispose();
      await plugin!.dispose();
      expect(detached).toBe(1);
      expect((globalThis as any)[marker]).toBe(1);
    } finally {
      delete (globalThis as any)[marker];
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('插件开放兼容（M2.2：onLoad/NL 触发/命令注册）', () => {
  it('registerNlTrigger 运行时生效（新意图词直达命令）', () => {
    const off = registerNlTrigger(/帮我(?:倒|泡)杯咖啡/i, '/coffee');
    expect(routeNaturalLanguage('帮我泡杯咖啡')).toBe('/coffee');
    off();
    expect(routeNaturalLanguage('帮我泡杯咖啡')).toBeNull();
  });
  it('插件 NL 触发按快照替换并支持代际安全清理', () => {
    const oldPlugin = {
      manifest: { name: 'old', version: '1', nlTriggers: [{ re: '泡旧咖啡', cmd: '/old-coffee' }] },
      dir: '', tools: {}, commands: {}, async activate() {}, async dispose() {},
    };
    const newPlugin = {
      manifest: { name: 'next', version: '1', nlTriggers: [{ re: '泡新咖啡', cmd: '/new-coffee' }] },
      dir: '', tools: {}, commands: {}, async activate() {}, async dispose() {},
    };

    const disposeOld = registerPluginNlTriggers([oldPlugin]);
    expect(routeNaturalLanguage('泡旧咖啡')).toBe('/old-coffee');
    const disposeNew = registerPluginNlTriggers([newPlugin]);
    expect(routeNaturalLanguage('泡旧咖啡')).toBeNull();
    expect(routeNaturalLanguage('泡新咖啡')).toBe('/new-coffee');

    disposeOld();
    expect(routeNaturalLanguage('泡新咖啡')).toBe('/new-coffee');
    disposeNew();
    expect(routeNaturalLanguage('泡新咖啡')).toBeNull();
  });

  it('manifest.nlTriggers 解析进清单', () => {
    const m = parsePluginManifest(JSON.stringify({
      name: 'nl-test', nlTriggers: [{ re: '/测试意图/i', cmd: '/test' }, { re: '', cmd: '/skip' }],
    }));
    expect(m.nlTriggers).toHaveLength(1);
    expect(m.nlTriggers![0]!.cmd).toBe('/test');
  });
});
