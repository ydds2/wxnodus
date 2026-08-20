import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/app/CommandBus.js';
import { createLegacyPluginRuntime, type LegacyPluginRuntime } from '../src/application/extensions/legacyPluginRuntime.js';
import type { LoadedPlugin } from '../src/kernel/plugins.js';
import type { ToolDef } from '../src/kernel/tools.js';

const runtimes: LegacyPluginRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
});

function tool(name: string): ToolDef {
  return {
    schema: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
    danger: true,
    canonical: { namespace: 'plugin', source: name.split('_')[0] === name ? name : name.replace(/_tool$/, '') },
    run: async () => name,
  };
}

function plugin(name: string, options: {
  toolName?: string;
  command?: string;
  activate?: () => void | Promise<void>;
  dispose?: () => void | Promise<void>;
} = {}): LoadedPlugin {
  const toolName = options.toolName ?? `${name}_tool`;
  const command = options.command ?? 'run';
  return {
    manifest: { name, version: '1.0.0', commands: [command] },
    dir: name,
    tools: { [toolName]: tool(toolName) },
    commands: { [command]: async () => name },
    activate: async () => { await options.activate?.(); },
    dispose: async () => { await options.dispose?.(); },
  };
}

describe('legacy plugin runtime', () => {
  it('成功重载先发布并激活候选，再释放旧插件', async () => {
    const events: string[] = [];
    const old = plugin('runtime_old', {
      activate: () => { events.push('activate-old'); },
      dispose: () => { events.push('dispose-old'); },
    });
    const next = plugin('runtime_next', {
      activate: () => { events.push('activate-next'); },
      dispose: () => { events.push('dispose-next'); },
    });
    const runtime = createLegacyPluginRuntime({
      initial: [old],
      load: async () => { events.push('load-next'); return [next]; },
      synchronizeTools: tools => { events.push(`tools:${Object.keys(tools).join(',')}`); },
    });
    runtimes.push(runtime);
    const bus = createCommandBus();

    expect((await runtime.bindCommandBus(bus)).ok).toBe(true);
    const reloaded = await runtime.reload();

    expect(reloaded.ok).toBe(true);
    expect(runtime.getPlugins()).toEqual([next]);
    expect(bus.list()).not.toContain('/runtime_old.run');
    expect(bus.list()).toContain('/runtime_next.run');
    expect(events).toEqual([
      'tools:runtime_old_tool', 'activate-old',
      'load-next', 'tools:runtime_next_tool', 'activate-next', 'dispose-old',
    ]);
  });

  it('工具同步失败恢复旧三表、保留旧实例并释放候选', async () => {
    let oldDisposed = 0;
    let candidateDisposed = 0;
    const old = plugin('rollback_old', { dispose: () => { oldDisposed++; } });
    const candidate = plugin('rollback_next', { dispose: () => { candidateDisposed++; } });
    const synchronized: string[][] = [];
    const runtime = createLegacyPluginRuntime({
      initial: [old],
      load: async () => [candidate],
      synchronizeTools: tools => {
        const names = Object.keys(tools);
        synchronized.push(names);
        if (names.includes('rollback_next_tool')) throw new Error('catalog rejected candidate');
      },
    });
    runtimes.push(runtime);
    const bus = createCommandBus();
    await runtime.bindCommandBus(bus);

    const reloaded = await runtime.reload();

    expect(reloaded.ok).toBe(false);
    expect(runtime.getPlugins()).toEqual([old]);
    expect(bus.list()).toContain('/rollback_old.run');
    expect(bus.list()).not.toContain('/rollback_next.run');
    expect(synchronized).toEqual([
      ['rollback_old_tool'],
      ['rollback_next_tool'],
      ['rollback_old_tool'],
    ]);
    expect(candidateDisposed).toBe(1);
    expect(oldDisposed).toBe(0);
  });

  it('候选激活失败恢复旧快照并清理候选一次', async () => {
    let candidateDisposed = 0;
    const old = plugin('activation_old');
    const candidate = plugin('activation_next', {
      activate: () => { throw new Error('activation failed'); },
      dispose: () => { candidateDisposed++; },
    });
    const runtime = createLegacyPluginRuntime({
      initial: [old],
      load: async () => [candidate],
      synchronizeTools: () => {},
    });
    runtimes.push(runtime);
    const bus = createCommandBus();
    await runtime.bindCommandBus(bus);

    const reloaded = await runtime.reload();

    expect(reloaded.ok).toBe(false);
    expect(runtime.getPlugins()).toEqual([old]);
    expect(bus.list()).toContain('/activation_old.run');
    expect(bus.list()).not.toContain('/activation_next.run');
    expect(candidateDisposed).toBe(1);
  });

  it('空候选清除最后一个插件的工具与命令', async () => {
    const synchronized: string[][] = [];
    const runtime = createLegacyPluginRuntime({
      initial: [plugin('empty_old')],
      load: async () => [],
      synchronizeTools: tools => { synchronized.push(Object.keys(tools)); },
    });
    runtimes.push(runtime);
    const bus = createCommandBus();
    await runtime.bindCommandBus(bus);

    const reloaded = await runtime.reload();

    expect(reloaded.ok).toBe(true);
    expect(runtime.getPlugins()).toEqual([]);
    expect(bus.list()).not.toContain('/empty_old.run');
    expect(synchronized).toEqual([['empty_old_tool'], []]);
  });

  it('并发 reload 串行提交，每次基于前一次已发布快照', async () => {
    const events: string[] = [];
    const first = plugin('serial_first', { dispose: () => { events.push('dispose-first'); } });
    const second = plugin('serial_second', { dispose: () => { events.push('dispose-second'); } });
    let loads = 0;
    let releaseFirst!: () => void;
    const firstLoad = new Promise<void>(resolve => { releaseFirst = resolve; });
    const runtime = createLegacyPluginRuntime({
      initial: [plugin('serial_old', { dispose: () => { events.push('dispose-old'); } })],
      load: async () => {
        loads++;
        events.push(`load-${loads}`);
        if (loads === 1) await firstLoad;
        return loads === 1 ? [first] : [second];
      },
      synchronizeTools: tools => { events.push(`tools:${Object.keys(tools).join(',')}`); },
    });
    runtimes.push(runtime);
    const bus = createCommandBus();
    await runtime.bindCommandBus(bus);

    const reloadOne = runtime.reload();
    await Promise.resolve();
    const reloadTwo = runtime.reload();
    await Promise.resolve();
    expect(loads).toBe(1);
    releaseFirst();
    await Promise.all([reloadOne, reloadTwo]);

    expect(runtime.getPlugins()).toEqual([second]);
    expect(events).toEqual([
      'tools:serial_old_tool',
      'load-1', 'tools:serial_first_tool', 'dispose-old',
      'load-2', 'tools:serial_second_tool', 'dispose-first',
    ]);
  });

  it('dispose 清除工具和命令，并在同步失败时仍释放插件', async () => {
    let disposed = 0;
    let rejectClear = false;
    const runtime = createLegacyPluginRuntime({
      initial: [plugin('shutdown_old', { dispose: () => { disposed++; } })],
      load: async () => [],
      synchronizeTools: tools => {
        if (rejectClear && Object.keys(tools).length === 0) throw new Error('clear failed');
      },
    });
    const bus = createCommandBus();
    await runtime.bindCommandBus(bus);
    rejectClear = true;

    await expect(runtime.dispose()).rejects.toThrow('clear failed');

    expect(disposed).toBe(1);
    expect(runtime.getPlugins()).toEqual([]);
    expect(bus.list()).not.toContain('/shutdown_old.run');
    await expect(runtime.reload()).resolves.toMatchObject({ ok: false, message: '插件 runtime 已关闭' });
  });
});
