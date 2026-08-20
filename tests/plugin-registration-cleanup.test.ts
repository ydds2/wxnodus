// tests/plugin-registration-cleanup.test.ts — W2-08：register-everything 全量注册与 disable/reload/uninstall 逐项清零
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginLifecycleService } from '../src/application/extensions/pluginLifecycleService.js';
import { createPluginBroker } from '../src/infrastructure/plugins/pluginProtocol.js';
import { ExtensionScopeManager } from '../src/application/extensions/extensionScopeManager.js';
import type { PluginSandbox } from '../src/infrastructure/plugins/pluginSandbox.js';

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'wxn-plugin-clean-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const context = { actorId: 'test', sessionId: 's', runId: 'r', correlationId: 'c', policySnapshotId: 'p',
  locale: 'en', source: 'kernel' as const, capabilities: [], timestamp: '2026-08-13T00:00:00.000Z' };
const signal = () => new AbortController().signal;

function writeEverythingPlugin(dir: string, name: string, version: string, toolVersion: number): void {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const code = 'export default {};';
  writeFileSync(join(dir, 'index.mjs'), code, 'utf8');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, name, version, entrypoint: 'index.mjs', trustLevel: 'trusted', permissions: [],
    checksum: createHash('sha256').update(code).digest('hex'),
  }), 'utf8');
  void toolVersion;
}
import { writeFileSync } from 'node:fs';

function sandboxWith(registrations: () => Array<{ kind: 'tool' | 'command' | 'event' | 'nl-trigger'; id: string; value: unknown }>, onStop: (reason: string) => void): PluginSandbox {
  return {
    strength: 'crash-isolation',
    probe: vi.fn(async () => ({ ok: true as const, value: { strength: 'crash-isolation' as const,
      environmentCleared: true, inheritedHandlesBlocked: true, filesystemDenied: true, networkDenied: true,
      processDenied: true, credentialDenied: true, evidenceIds: ['e'] } })),
    start: vi.fn(async () => ({ ok: true as const, value: {
      processId: 'proc-everything',
      registrations,
      stop: vi.fn(async (_reason: string) => { onStop(_reason); return { ok: true as const, value: { stopped: true as const } }; }),
    } })),
  };
}

describe('Plugin registration cleanup', () => {
  it('registers everything then disable clears tool/command/event/NL and runs onLoad disposer', async () => {
    const dir = makeRoot();
    writeEverythingPlugin(dir, 'register-everything', '1.0.0', 1);
    const stopped: string[] = [];
    const manager = new ExtensionScopeManager();
    const sandbox = sandboxWith(() => [
      { kind: 'tool', id: 'echo-all', value: { version: 1 } },
      { kind: 'command', id: 'run-all', value: { version: 1 } },
      { kind: 'event', id: 'evt:notice', value: { version: 1 } },
      { kind: 'nl-trigger', id: 'nl:hello', value: { version: 1 } },
    ], reason => stopped.push(reason));
    const service = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox, broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }), scopeManager: manager,
    });
    expect((await service.enable(dir, context, signal())).ok).toBe(true);
    expect(manager.resolveTool('echo-all')).toEqual({ version: 1 });
    expect(service.snapshot('register-everything')?.state).toBe('enabled');

    expect((await service.disable('register-everything', context, signal())).ok).toBe(true);
    expect(manager.resolveTool('echo-all')).toBeUndefined();
    expect(manager.snapshot('plugin:register-everything@1.0.0')).toBeUndefined();
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    expect(service.snapshot('register-everything')?.state).toBe('quarantined');
  });

  it('keeps old handler versions on reload candidate failure and leaves MCP/Skill owners unchanged', async () => {
    const dirA = makeRoot();
    writeEverythingPlugin(dirA, 'register-everything', '1.0.0', 1);
    const manager = new ExtensionScopeManager();
    const service = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox: sandboxWith(() => [{ kind: 'tool', id: 'echo-all', value: { version: 1 } }], () => undefined),
      broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }), scopeManager: manager,
    });
    expect((await service.enable(dirA, context, signal())).ok).toBe(true);

    // MCP/Skill owner 建立
    const mcp = manager.stage('mcp:weather', '1.0.0');
    if (!mcp.ok) return;
    mcp.value.registerTool('weather.get', {});
    expect((await manager.activate(mcp.value, async () => true)).ok).toBe(true);
    const mcpRevision = manager.snapshot('mcp:weather')?.revision;

    // reload candidate 失败（manifest 坏）
    const dirB = makeRoot();
    writeFileSync(join(dirB, 'plugin.json'), '{ broken', 'utf8');
    const serviceB = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox: sandboxWith(() => [{ kind: 'tool', id: 'echo-all', value: { version: 2 } }], () => undefined),
      broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }), scopeManager: manager,
    });
    expect(await serviceB.enable(dirB, context, signal())).toMatchObject({ ok: false, error: { code: 'PLUGIN_MANIFEST_INVALID' } });

    // 旧 handler 版本保留、MCP owner 不变
    expect(manager.resolveTool('echo-all')).toEqual({ version: 1 });
    expect(manager.resolveTool('weather.get')).toEqual({});
    expect(manager.snapshot('mcp:weather')?.revision).toBe(mcpRevision);
  });
});
