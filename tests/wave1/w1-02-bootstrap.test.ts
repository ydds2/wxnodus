import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/bootstrap/createApplication.js';
import type { BootstrapOptions, BootstrapPhase, BootstrapState } from '../../src/bootstrap/bootstrapTypes.js';
import { capabilityUnavailable, type CapabilityPort } from '../../src/domain/capabilities/capability.js';
import { gatewayError } from '../../src/protocol/errors.js';
import { err, ok } from '../../src/protocol/results.js';

const services = {
  sessions: { open: async () => ok({ sessionId: 's1' }) },
  prompts: { submit: async () => ok({ runId: 'r1' }) },
  commands: { execute: async () => ok({ output: '' }) },
  memory: { search: async () => ok([]) },
};
const gateway = { request: async () => ok({}), subscribe: () => () => undefined };
const capabilities: CapabilityPort = {
  snapshot: () => ({
    id: 'caps-1',
    policySnapshotId: 'policy-1',
    generatedAt: '2026-08-13T00:00:00.000Z',
    profile: 'standard',
    platform: 'win32',
    states: { command: 'available', memory: 'available', 'offline-model': 'available', voice: 'unavailable', computer: 'unavailable', forge: 'unavailable', distribution: 'unavailable', session: 'unavailable', build: 'unavailable', verify: 'unavailable', evidence: 'unavailable', browser: 'unavailable', 'mcp-client': 'unavailable', 'mcp-server': 'unavailable', skill: 'unavailable', plugin: 'unavailable', task: 'unavailable', subagent: 'unavailable' },
    descriptors: { command: { id: 'command', profile: 'standard', platform: 'win32', requirement: 'required', state: 'available', delivered: true, stableStatus: 'DELIVERED', source: 'fixture', checksum: '0'.repeat(64) } } as never,
  }),
  require(id) {
    return this.snapshot().states[id] === 'available'
      ? ok({ id, snapshotId: this.snapshot().id })
      : capabilityUnavailable(id, this.snapshot().id);
  },
};

function phase(
  name: string,
  order: string[],
  disposed: string[],
  patch: Partial<BootstrapState> = {},
): BootstrapPhase {
  return async () => {
    order.push(name);
    return ok({
      patch,
      resources: [{ id: name, dispose: async () => { disposed.push(name); } }],
    });
  };
}

function options(order: string[], disposed: string[]): BootstrapOptions {
  return {
    headless: true,
    phases: {
      config: phase('config', order, disposed),
      repositories: phase('repositories', order, disposed),
      kernel: phase('kernel', order, disposed, { services: services as never, gateway: gateway as never, capabilities }),
      extensions: phase('extensions', order, disposed),
      presentation: phase('presentation', order, disposed),
    },
  };
}

describe('W1-02 bootstrap lifecycle', () => {
  it('runs fixed phases and shuts resources down once in reverse order', async () => {
    const order: string[] = [];
    const disposed: string[] = [];
    const result = await createApplication(options(order, disposed));
    expect(result.ok).toBe(true);
    expect(order).toEqual(['config', 'repositories', 'kernel', 'extensions', 'presentation']);
    if (!result.ok) return;
    await result.value.shutdown('test-complete');
    await result.value.shutdown('duplicate');
    expect(disposed).toEqual(['presentation', 'extensions', 'kernel', 'repositories', 'config']);
  });

  it('disposes only started resources when a phase fails and preserves the stable cause code', async () => {
    const order: string[] = [];
    const disposed: string[] = [];
    const opts = options(order, disposed);
    opts.phases.kernel = async () => {
      order.push('kernel');
      return err(gatewayError('REPOSITORY_OPEN_FAILED', '数据库打不开', 'repository.open_failed'));
    };
    const result = await createApplication(opts);
    expect(result.ok).toBe(false);
    expect(order).toEqual(['config', 'repositories', 'kernel']);
    expect(disposed).toEqual(['repositories', 'config']);
    if (!result.ok) {
      expect(result.error.code).toBe('BOOTSTRAP_PHASE_FAILED');
      expect(result.error.details).toMatchObject({ phase: 'kernel', causeCode: 'REPOSITORY_OPEN_FAILED' });
    }
  });

  it('exposes CapabilityPort now and returns a stable unavailable code', () => {
    const result = capabilities.require('voice');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  it('keeps headless application/bootstrap/domain sources free of React and Ink imports', () => {
    const root = process.cwd();
    const files = [
      'src/application/applicationServices.ts',
      'src/bootstrap/bootstrapTypes.ts',
      'src/bootstrap/createApplication.ts',
      'src/domain/capabilities/capability.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).not.toMatch(/from ['"](?:react|ink|@wxnodus\/ink)/);
      expect(source).not.toMatch(/src\/infrastructure|\.\.\/infrastructure/);
    }
  });
});
