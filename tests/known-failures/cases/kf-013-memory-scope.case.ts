import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

await runKnownFailureCase({
  failureId: 'KF-013',
  expectedFailureCode: 'MEMORY_SCOPE_LEAK',
  assertionMessage: 'MEMORY_SCOPE_LEAK',
  run: async () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/memory.ts'), 'utf8');
    // recallHybrid 的 KNN 分支按 id 取行但不过滤 session_id——跨会话向量召回泄漏
    const knnQuery = src.match(/knnStmt\.all\([^)]*\)/s)?.[0] ?? '';
    assert.ok(/session_id|sid/.test(knnQuery), 'MEMORY_SCOPE_LEAK');
  },
});
