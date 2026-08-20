// tests/unit/build/buildContracts.test.ts — W3-07 Step 1：严格验收 + 可执行 DAG（计划原文）
import { describe, expect, it } from 'vitest';
import { validateAcceptance } from '../../../src/domain/build/acceptance.js';
import { executePlanDag } from '../../../src/domain/build/planDag.js';

it('rejects required criteria without verifier/evidence fields', () => {
  expect(validateAcceptance([{ id: 'starts', required: true, description: 'server starts' }])).toMatchObject({
    ok: false,
    error: { code: 'BUILD_SPEC_INVALID' },
  });
});

it('executes DAG nodes, blocks dependents, and preserves independent diagnostics', async () => {
  const calls: string[] = [];
  const result = await executePlanDag([
    { id: 'install', dependsOn: [], run: async () => { calls.push('install'); return { ok: true as const, value: undefined }; } },
    { id: 'build', dependsOn: ['install'], run: async () => { calls.push('build'); return { ok: false as const, error: { code: 'BUILD_NODE_FAILED', message: 'build', messageKey: 'BUILD_NODE_FAILED', retryable: false } }; } },
    { id: 'start', dependsOn: ['build'], run: async () => { calls.push('start'); return { ok: true as const, value: undefined }; } },
    { id: 'diagnose', dependsOn: ['install'], run: async () => { calls.push('diagnose'); return { ok: true as const, value: undefined }; } },
  ], AbortSignal.timeout(1_000));

  expect(calls).toEqual(['install', 'build', 'diagnose']);
  expect(result.nodes).toMatchObject({
    build: { status: 'failed', code: 'BUILD_NODE_FAILED' },
    start: { status: 'blocked', code: 'BUILD_DEPENDENCY_BLOCKED' },
    diagnose: { status: 'passed' },
  });
});
