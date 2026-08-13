import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

await runKnownFailureCase({
  failureId: 'KF-022',
  expectedFailureCode: 'SCAFFOLD_PIPELINE_BYPASS',
  assertionMessage: 'SCAFFOLD_PIPELINE_BYPASS',
  run: async () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/build');
    const scaffold = readFileSync(resolve(dir, 'scaffold.ts'), 'utf8');
    // 正确行为：scaffold 步骤必须由 BuildPlan（模块拓扑）驱动；当前 instantiate 只消费 Spec
    assert.ok(/BuildPlan|topoSort|plan/.test(scaffold), 'SCAFFOLD_PIPELINE_BYPASS');
  },
});
