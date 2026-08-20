import type { CommandBus } from '../../app/CommandBus.js';
import type { ToolDef } from '../../kernel/tools.js';
import {
  pluginToolsToExtra,
  registerPluginCommands,
  registerPluginNlTriggers,
  type LoadedPlugin,
} from '../../kernel/plugins.js';

export interface PluginRuntimeSnapshot {
  plugins: LoadedPlugin[];
  toolCount: number;
  commandCount: number;
}

export interface PluginRuntimeResult extends PluginRuntimeSnapshot {
  ok: boolean;
  cleanupFailures: number;
  message: string;
}

export interface LegacyPluginRuntime {
  getPlugins(): LoadedPlugin[];
  bindCommandBus(bus: CommandBus): Promise<PluginRuntimeResult>;
  reload(): Promise<PluginRuntimeResult>;
  dispose(): Promise<void>;
}

interface LegacyPluginRuntimeOptions {
  initial: LoadedPlugin[];
  load(): Promise<LoadedPlugin[]>;
  synchronizeTools(tools: Record<string, ToolDef>): void;
}

function snapshot(plugins: LoadedPlugin[]): PluginRuntimeSnapshot {
  return {
    plugins: [...plugins],
    toolCount: Object.keys(pluginToolsToExtra(plugins)).length,
    commandCount: plugins.reduce((sum, plugin) => sum + Object.keys(plugin.commands).length, 0),
  };
}

async function disposePlugins(plugins: readonly LoadedPlugin[]): Promise<number> {
  const settled = await Promise.allSettled(plugins.map(plugin => plugin.dispose()));
  return settled.filter(result => result.status === 'rejected').length;
}

async function activatePlugins(plugins: readonly LoadedPlugin[]): Promise<void> {
  for (const plugin of plugins) await plugin.activate();
}

export function createLegacyPluginRuntime(options: LegacyPluginRuntimeOptions): LegacyPluginRuntime {
  let current = [...options.initial];
  let commandBus: CommandBus | undefined;
  let bound = false;
  let disposed = false;
  let operation: Promise<void> = Promise.resolve();

  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = operation.then(run, run);
    operation = next.then(() => undefined, () => undefined);
    return next;
  };

  const publish = (plugins: LoadedPlugin[]): void => {
    if (!commandBus) throw new Error('插件命令总线尚未绑定');
    // Agent/catalog 是可拒绝的候选门；通过后，同一同步 tick 内替换命令与 NL 表。
    options.synchronizeTools(pluginToolsToExtra(plugins));
    registerPluginCommands(commandBus, plugins);
    registerPluginNlTriggers(plugins);
  };

  const restore = (plugins: LoadedPlugin[]): void => {
    options.synchronizeTools(pluginToolsToExtra(plugins));
    if (commandBus) registerPluginCommands(commandBus, plugins);
    registerPluginNlTriggers(plugins);
  };

  const result = (ok: boolean, plugins: LoadedPlugin[], cleanupFailures: number, message: string): PluginRuntimeResult => ({
    ok,
    ...snapshot(plugins),
    cleanupFailures,
    message,
  });

  return {
    getPlugins: () => [...current],
    async bindCommandBus(bus) {
      return enqueue(async () => {
        if (disposed) return result(false, current, 0, '插件 runtime 已关闭');
        if (bound) {
          if (commandBus !== bus) return result(false, current, 0, '插件 runtime 已绑定其他命令总线');
          return result(true, current, 0, '插件 runtime 已绑定');
        }
        commandBus = bus;
        try {
          publish(current);
          await activatePlugins(current);
          bound = true;
          return result(true, current, 0, `插件 runtime 已绑定（${current.length} 个插件）`);
        } catch (cause) {
          let restoreFailure = '';
          try { restore([]); } catch (restoreCause) {
            restoreFailure = `；动态表清空失败：${String((restoreCause as Error)?.message ?? restoreCause).slice(0, 120)}`;
          }
          const cleanupFailures = await disposePlugins(current);
          current = [];
          commandBus = undefined;
          return result(false, current, cleanupFailures, `插件 runtime 绑定失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}${restoreFailure}`);
        }
      });
    },
    async reload() {
      return enqueue(async () => {
        if (disposed) return result(false, current, 0, '插件 runtime 已关闭');
        if (!bound || !commandBus) return result(false, current, 0, '插件 runtime 尚未绑定命令总线');

        let candidate: LoadedPlugin[] = [];
        try {
          candidate = await options.load();
          publish(candidate);
          await activatePlugins(candidate);
        } catch (cause) {
          let restoreFailure = '';
          try { restore(current); } catch (restoreCause) {
            restoreFailure = `；旧动态表恢复失败：${String((restoreCause as Error)?.message ?? restoreCause).slice(0, 120)}`;
          }
          const cleanupFailures = await disposePlugins(candidate);
          return result(false, current, cleanupFailures, `插件重载失败：${String((cause as Error)?.message ?? cause).slice(0, 160)}${restoreFailure}`);
        }

        const previous = current;
        current = candidate;
        const cleanupFailures = await disposePlugins(previous);
        const suffix = cleanupFailures ? `；${cleanupFailures} 个旧插件清理失败` : '';
        return result(true, current, cleanupFailures, `插件已热重载（${current.length} 个插件）${suffix}`);
      });
    },
    async dispose() {
      return enqueue(async () => {
        if (disposed) return;
        disposed = true;
        let failure: unknown;
        try { options.synchronizeTools({}); } catch (cause) { failure = cause; }
        try {
          if (commandBus) registerPluginCommands(commandBus, []);
          registerPluginNlTriggers([]);
        } catch (cause) { failure ??= cause; }
        const cleanupFailures = await disposePlugins(current);
        current = [];
        bound = false;
        commandBus = undefined;
        if (failure) throw failure;
        if (cleanupFailures) throw new Error(`${cleanupFailures} 个插件清理失败`);
      });
    },
  };
}
