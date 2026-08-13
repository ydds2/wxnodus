// tests/integration/buildService.test.ts — W3-07：Acceptance-driven BuildService（staging 隔离/预览审批/静态入口/开放域）
import { describe, expect, it, vi } from 'vitest';
import { BuildService } from '../../src/application/build/buildService.js';
import type { BuildServicePorts } from '../../src/application/build/buildService.js';

const spec = [
  { id: 'starts', required: true, description: 'server starts', verifierId: 'process.readiness', expected: true, evidenceRequirements: ['stdout'] },
  { id: 'reads-back', required: true, description: 'data reads back', verifierId: 'database.query', expected: { name: 'x' }, evidenceRequirements: ['stdout'] },
];

const snapshotInput = {
  runId: 'run-1',
  artifactHash: 'a'.repeat(64),
  environmentSnapshotId: 'env-1',
  capabilitySnapshotId: 'cap-1',
  policySnapshotId: 'policy-1',
};

function makePorts(overrides: Partial<BuildServicePorts> = {}) {
  const nodesRun: string[] = [];
  const ports: BuildServicePorts = {
    workspace: {
      stage: vi.fn(async () => ({ ok: true as const, value: { stagingDir: 'C:/tmp/stage-1' } })),
      commit: vi.fn(async () => ({ ok: true as const, value: undefined })),
      abandon: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ ok: true as const, value: { changed: [] } })),
    },
    verifierMap: { resolve: vi.fn(criterion => ({ ok: true as const, value: { verifierId: criterion.verifierId } })) },
    nodes: vi.fn(() => [
      { id: 'install', dependsOn: [], run: async () => { nodesRun.push('install'); return { ok: true as const, value: undefined }; } },
      { id: 'evidence', dependsOn: ['install'], run: async () => { nodesRun.push('evidence'); return { ok: true as const, value: undefined }; } },
    ]),
    staticEntry: { verify: vi.fn(async () => ({ ok: true as const, value: { servesRoot: true } })) },
    decide: vi.fn((criteria: Array<{ id: string }>) => ({
      ok: true as const,
      value: { status: 'succeeded' as const, reasons: [], criteria: criteria.map(c => ({ id: c.id, status: 'passed' as const })) },
    })),
    ...overrides,
  };
  return { ports, nodesRun };
}

const request = { spec, targetDir: 'C:/workspace/proj', dataDir: 'C:/data', snapshotInput };

describe('BuildService', () => {
  it('rejects incomplete specs and unmapped criteria before any staging', async () => {
    const { ports } = makePorts();
    const service = new BuildService(ports);
    expect(await service.compileAndRun({ ...request, spec: [{ id: 'x' }] }, AbortSignal.timeout(100)))
      .toMatchObject({ ok: false, error: { code: 'BUILD_SPEC_INVALID' } });
    expect(await service.compileAndRun(request, AbortSignal.timeout(100))).toMatchObject({ ok: true });
    expect(ports.workspace.stage).toHaveBeenCalledTimes(1);

    const unmapped = makePorts({ verifierMap: { resolve: vi.fn(() => ({ ok: false as const, error: { code: 'BUILD_VERIFIER_MAPPING_MISSING', message: 'x', messageKey: 'x', retryable: false } })) } });
    expect(await new BuildService(unmapped.ports).compileAndRun(request, AbortSignal.timeout(100)))
      .toMatchObject({ ok: false, error: { code: 'BUILD_VERIFIER_MAPPING_MISSING' } });
    expect(unmapped.ports.workspace.stage).not.toHaveBeenCalled();
  });

  it('never fabricates completion for open-domain requests', async () => {
    const { ports } = makePorts();
    expect(await new BuildService(ports).compileAndRun({ ...request, openDomain: true }, AbortSignal.timeout(100)))
      .toMatchObject({ ok: false, error: { code: 'BUILD_OPEN_DOMAIN_UNSUPPORTED' } });
    expect(ports.workspace.stage).not.toHaveBeenCalled();
  });

  it('requires preview approval before mutating an existing project', async () => {
    const ports = makePorts();
    ports.ports.workspace.diff = vi.fn(async () => ({ ok: true as const, value: { changed: ['src/index.ts'] } }));
    expect(await new BuildService(ports.ports).compileAndRun({ ...request, existingProject: true }, AbortSignal.timeout(100)))
      .toMatchObject({ ok: false, error: { code: 'BUILD_PREVIEW_APPROVAL_REQUIRED' } });
    expect(await new BuildService(ports.ports).compileAndRun({ ...request, existingProject: true, previewApproved: true }, AbortSignal.timeout(100)))
      .toMatchObject({ ok: true });
  });

  it('fails with BUILD_STATIC_ENTRY_MISSING when the generated server cannot serve /', async () => {
    const ports = makePorts({ staticEntry: { verify: vi.fn(async () => ({ ok: true as const, value: { servesRoot: false } })) } });
    expect(await new BuildService(ports.ports).compileAndRun(request, AbortSignal.timeout(100)))
      .toMatchObject({ ok: false, error: { code: 'BUILD_STATIC_ENTRY_MISSING' } });
  });

  it('abandons staging when required criteria do not all pass, and never commits', async () => {
    const ports = makePorts({
      decide: vi.fn(criteria => ({
        ok: true as const,
        value: {
          status: 'incomplete' as const,
          reasons: ['BUILD_REQUIRED_CRITERION_MISSING'],
          criteria: criteria.map((c: { id: string }, index: number) => ({ id: c.id, status: index === 0 ? 'passed' as const : 'failed' as const })),
        },
      })),
    });
    const result = await new BuildService(ports.ports).compileAndRun(request, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: true, value: { committed: false } });
    expect(ports.ports.workspace.commit).not.toHaveBeenCalled();
    expect(ports.ports.workspace.abandon).toHaveBeenCalled();
  });
});
