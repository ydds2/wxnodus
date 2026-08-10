// tests/kernel-plugins.test.ts — 插件系统：发现/加载/工具构建/命令/启停
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAllPlugins, loadPlugin, parsePluginManifest, setPluginEnabled } from '../src/kernel/plugins.js';

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
  it('正常清单解析工具/命令/enabled', () => {
    const m = parsePluginManifest(JSON.stringify({ name: 'x', version: '2', tools: [{ name: 't1', description: 'd' }], commands: ['c1'] }));
    expect(m.name).toBe('x');
    expect(m.tools?.[0]?.name).toBe('t1');
    expect(m.commands).toEqual(['c1']);
    expect(m.enabled).toBe(true);
  });
  it('enabled:false 与非法名', () => {
    expect(parsePluginManifest(JSON.stringify({ name: 'y', enabled: false })).enabled).toBe(false);
    expect(() => parsePluginManifest(JSON.stringify({ name: '坏 名' }))).toThrow();
  });
});

describe('插件发现与加载', () => {
  it('加载全部插件：工具构建 + 命令加载 + 禁用跳过', async () => {
    const plugins = await loadAllPlugins(dir, process.cwd());
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
    const p = await loadPlugin(d, process.cwd(), dir);
    expect(p).not.toBeNull();
    expect(Object.keys(p!.tools).length).toBe(0); // 声明了但未实现 → 跳过
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
