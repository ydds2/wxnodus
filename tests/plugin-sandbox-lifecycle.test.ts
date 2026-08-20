// tests/plugin-sandbox-lifecycle.test.ts — W2-08：Trusted crash-isolation、worker crash、manifest 缺失、untrusted 任一 probe false、abort fencing
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginLifecycleService } from '../src/application/extensions/pluginLifecycleService.js';
import { createPluginBroker } from '../src/infrastructure/plugins/pluginProtocol.js';
import { ExtensionScopeManager } from '../src/application/extensions/extensionScopeManager.js';
import type { PluginSandbox } from '../src/infrastructure/plugins/pluginSandbox.js';

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'wxn-plugin-life-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const context = { actorId: 'test', sessionId: 's', runId: 'r', correlationId: 'c', policySnapshotId: 'p',
  locale: 'en', source: 'kernel' as const, capabilities: [], timestamp: '2026-08-13T00:00:00.000Z' };
const signal = () => new AbortController().signal;

function writePlugin(dir: string, name: string, trustLevel: 'trusted' | 'untrusted', permissions: unknown[] = []): void {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const code = 'export default {};';
  writeFileSync(join(dir, 'index.mjs'), code, 'utf8');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, name, version: '1.0.0', entrypoint: 'index.mjs', trustLevel,
    permissions, checksum: createHash('sha256').update(code).digest('hex'),
  }), 'utf8');
}

function sandboxFixture(overrides: Partial<PluginSandbox> & { startError?: string } = {}): PluginSandbox & { start: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async () => ({ ok: true as const, value: { stopped: true as const } }));
  return {
    strength: overrides.strength ?? 'crash-isolation',
    probe: overrides.probe ?? vi.fn(async () => ({ ok: true as const, value: {
      strength: (overrides.strength ?? 'crash-isolation') as 'crash-isolation' | 'os-enforced',
      environmentCleared: true, inheritedHandlesBlocked: true, filesystemDenied: true,
      networkDenied: true, processDenied: true, credentialDenied: true, evidenceIds: ['e:probe'],
    } })),
    start: vi.fn(async () => overrides.startError
      ? ({ ok: false as const, error: { code: overrides.startError, message: overrides.startError, messageKey: overrides.startError, retryable: false } })
      : ({ ok: true as const, value: { processId: 'proc-1', registrations: () => [{ kind: 'tool', id: 'echo', value: { version: 1 } }], stop } })),
  } as never;
}

describe('Plugin sandbox lifecycle', () => {
  it('grants trusted plugins crash-isolation and activates a registered tool', async () => {
    const dir = makeRoot();
    writePlugin(dir, 'trusted-echo', 'trusted');
    const sandbox = sandboxFixture();
    const manager = new ExtensionScopeManager();
    const service = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox, broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }), scopeManager: manager,
    });
    const result = await service.enable(dir, context, signal());
    expect(result.ok).toBe(true);
    expect(service.snapshot('trusted-echo')).toMatchObject({ state: 'enabled', sandboxStrength: 'crash-isolation' });
    expect(manager.resolveTool('echo')).toEqual({ version: 1 });
  });

  it('reports worker crash and the main process continues to serve other plugins', async () => {
    const dirA = makeRoot();
    writePlugin(dirA, 'good-plugin', 'trusted');
    const goodSandbox = sandboxFixture();
    const manager = new ExtensionScopeManager();
    const service = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox: goodSandbox, broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }), scopeManager: manager,
    });
    expect((await service.enable(dirA, context, signal())).ok).toBe(true);

    const dirB = makeRoot();
    writePlugin(dirB, 'crash-plugin', 'trusted');
    const crashSandbox = sandboxFixture({ startError: 'PLUGIN_WORKER_CRASHED' });
    const serviceB = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox: crashSandbox, broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }), scopeManager: manager,
    });
    expect(await serviceB.enable(dirB, context, signal())).toMatchObject({ ok: false, error: { code: 'PLUGIN_WORKER_CRASHED' } });
    expect(serviceB.snapshot('crash-plugin')?.state).toBe('quarantined');
    // 主进程继续：good-plugin 仍在
    expect(service.snapshot('good-plugin')?.state).toBe('enabled');
    expect(manager.resolveTool('echo')).toEqual({ version: 1 });
  });

  it('returns PLUGIN_MANIFEST_INVALID for missing permissions/checksum/trust', async () => {
    const dir = makeRoot();
    writeFileSync(join(dir, 'index.mjs'), 'export default {};', 'utf8');
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ schemaVersion: 1, name: 'bad', version: '1.0.0', entrypoint: 'index.mjs', trustLevel: 'trusted', permissions: [], checksum: '0'.repeat(64) }), 'utf8');
    const service = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox: sandboxFixture(), broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }),
      scopeManager: { stage: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
    });
    expect(await service.enable(dir, context, signal())).toMatchObject({ ok: false, error: { code: 'PLUGIN_CHECKSUM_MISMATCH' } });
  });

  it('keeps untrusted quarantined when any probe dimension is false even with os-enforced strength', async () => {
    const dir = makeRoot();
    writePlugin(dir, 'untrusted-fs-read', 'untrusted', [{ kind: 'workspace.read' }]);
    const sandbox = sandboxFixture({ strength: 'os-enforced' });
    (sandbox.probe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true as const, value: {
      strength: 'os-enforced' as const, environmentCleared: true, inheritedHandlesBlocked: true,
      filesystemDenied: false, networkDenied: true, processDenied: true, credentialDenied: true, evidenceIds: ['e:probe'],
    } });
    const service = createPluginLifecycleService({
      dataDir: makeRoot(), sandbox, broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }),
      scopeManager: { stage: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
    });
    expect(await service.enable(dir, context, signal())).toMatchObject({ ok: false, error: { code: 'PLUGIN_SANDBOX_UNAVAILABLE' } });
    expect(service.snapshot('untrusted-fs-read')?.state).toBe('quarantined');
  });
});
