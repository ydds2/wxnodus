import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginLifecycleService } from '../src/application/extensions/pluginLifecycleService.js';
import { createPluginBroker } from '../src/infrastructure/plugins/pluginProtocol.js';
import type { PluginSandbox } from '../src/infrastructure/plugins/pluginSandbox.js';

const fixtureRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures/plugins',
);
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxn-plugin-malicious-'));
  roots.push(root);
  return root;
}

const context = {
  actorId: 'test:plugin',
  sessionId: 'session-plugin',
  runId: 'run-plugin',
  correlationId: 'corr-plugin',
  policySnapshotId: 'p1',
  locale: 'en',
  source: 'kernel',
  capabilities: [],
  timestamp: '2026-08-13T00:00:00.000Z',
} as const;

function sandbox(strength: PluginSandbox['strength']): PluginSandbox {
  return {
    strength,
    probe: vi.fn(async () => ({
      ok: true as const,
      value: {
        strength,
        environmentCleared: strength === 'os-enforced',
        inheritedHandlesBlocked: strength === 'os-enforced',
        filesystemDenied: strength === 'os-enforced',
        networkDenied: strength === 'os-enforced',
        processDenied: strength === 'os-enforced',
        credentialDenied: strength === 'os-enforced',
        evidenceIds: ['evidence:sandbox-probe'],
      },
    })),
    start: vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'SHOULD_NOT_START',
        message: 'sandbox start must not be reached',
        messageKey: 'SHOULD_NOT_START',
        retryable: false,
      },
    })),
  };
}

describe('malicious Plugin fixtures', () => {
  it.each([
    ['untrusted-fs-read', 'workspace.read'],
    ['untrusted-network', 'network.fetch'],
    ['untrusted-process-env', 'process.spawn'],
  ])('quarantines %s when only crash isolation is available', async (fixture, capability) => {
    const dataDir = makeRoot();
    const pipelineExecute = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'PLUGIN_BROKER_CAPABILITY_DENIED',
        message: capability,
        messageKey: 'PLUGIN_BROKER_CAPABILITY_DENIED',
        retryable: false,
      },
    }));
    const broker = createPluginBroker({ pipeline: { execute: pipelineExecute } as never });
    const requestSpy = vi.spyOn(broker, 'request');
    const service = createPluginLifecycleService({
      dataDir,
      sandbox: sandbox('crash-isolation'),
      broker,
      scopeManager: {
        stage: vi.fn(),
        activate: vi.fn(),
        deactivate: vi.fn(),
      },
    });

    const result = await service.enable(
      join(fixtureRoot, fixture),
      context,
      new AbortController().signal,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'PLUGIN_SANDBOX_UNAVAILABLE' }),
    });
    expect(service.snapshot(fixture)).toMatchObject({ state: 'quarantined' });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('does not confuse crash isolation with an OS-enforced sandbox', async () => {
    const service = createPluginLifecycleService({
      dataDir: makeRoot(),
      sandbox: sandbox('crash-isolation'),
      broker: createPluginBroker({ pipeline: { execute: vi.fn() } as never }),
      scopeManager: { stage: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
    });

    const result = await service.enable(
      join(fixtureRoot, 'untrusted-fs-read'),
      context,
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PLUGIN_SANDBOX_UNAVAILABLE');
    expect(service.snapshot('untrusted-fs-read')?.sandboxStrength).toBe('crash-isolation');
  });
});
