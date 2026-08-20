import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandBus } from '../src/app/CommandBus.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import type { HandlerCtx } from '../src/commands/handlers.js';
import type { LoadedPlugin } from '../src/kernel/plugins.js';

const dirs: string[] = [];
const previousCompositionRoot = process.env.WXNODUS_COMPOSITION_ROOT;

afterEach(() => {
  if (previousCompositionRoot === undefined) delete process.env.WXNODUS_COMPOSITION_ROOT;
  else process.env.WXNODUS_COMPOSITION_ROOT = previousCompositionRoot;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  process.env.WXNODUS_COMPOSITION_ROOT = 'legacy';
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-plugin-remove-'));
  dirs.push(dataDir);
  const pluginDir = join(dataDir, 'plugins', 'remove_me');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'remove_me', version: '1.0.0' }));
  writeFileSync(join(pluginDir, 'index.js'), 'export const tools = {};\n');
  const loaded: LoadedPlugin = {
    manifest: { name: 'remove_me', version: '1.0.0' },
    dir: pluginDir,
    tools: {},
    commands: {},
    async activate() {},
    async dispose() {},
  };
  return { dataDir, pluginDir, loaded };
}

function register(dataDir: string, loaded: LoadedPlugin, reloadPlugins: HandlerCtx['reloadPlugins']) {
  const bus = createCommandBus();
  registerExtHandlers(bus, {
    dataDir,
    cwd: dataDir,
    getPlugins: () => [loaded],
    reloadPlugins,
    config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
  } as unknown as HandlerCtx);
  return bus;
}

describe('/plugin remove runtime transaction', () => {
  it('在扫描根外暂存插件，发布成功后删除暂存目录', async () => {
    const { dataDir, pluginDir, loaded } = fixture();
    let reloads = 0;
    const bus = register(dataDir, loaded, async () => {
      reloads++;
      expect(existsSync(pluginDir)).toBe(false);
      expect(readdirSync(join(dataDir, 'plugins'))).toEqual([]);
      expect(readdirSync(join(dataDir, 'plugin-removals'))).toHaveLength(1);
      return { ok: true, plugins: [], toolCount: 0, commandCount: 0, cleanupFailures: 0, message: 'ok' };
    });

    const result = await bus.execute('/plugin remove remove_me');

    expect(result.ok).toBe(true);
    expect(result.output).toContain('插件已移除');
    expect(reloads).toBe(1);
    expect(existsSync(pluginDir)).toBe(false);
    expect(readdirSync(join(dataDir, 'plugin-removals'))).toEqual([]);
  });

  it('发布失败时恢复原目录并再次同步旧快照', async () => {
    const { dataDir, pluginDir, loaded } = fixture();
    let reloads = 0;
    const bus = register(dataDir, loaded, async () => {
      reloads++;
      if (reloads === 1) {
        expect(existsSync(pluginDir)).toBe(false);
        expect(readdirSync(join(dataDir, 'plugins'))).toEqual([]);
        return { ok: false, plugins: [loaded], toolCount: 0, commandCount: 0, cleanupFailures: 0, message: 'candidate rejected' };
      }
      expect(existsSync(pluginDir)).toBe(true);
      return { ok: true, plugins: [loaded], toolCount: 0, commandCount: 0, cleanupFailures: 0, message: 'restored' };
    });

    const result = await bus.execute('/plugin remove remove_me');

    expect(result.ok).toBe(true);
    expect(result.output).toContain('插件移除回滚：candidate rejected');
    expect(reloads).toBe(2);
    expect(existsSync(pluginDir)).toBe(true);
    expect(readdirSync(join(dataDir, 'plugin-removals'))).toEqual([]);
  });
});
