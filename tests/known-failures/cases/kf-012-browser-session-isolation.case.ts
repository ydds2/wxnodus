import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

await runKnownFailureCase({
  failureId: 'KF-012',
  expectedFailureCode: 'BROWSER_CONTEXT_SHARED',
  assertionMessage: 'BROWSER_CONTEXT_SHARED',
  run: async () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/browser.ts'), 'utf8');
    // 正确行为：浏览器上下文按会话隔离（sessionId 参数化）；当前模块级共享 browser/page 单例
    assert.ok(/sessionId|session_id|context\s*[:(]/.test(src), 'BROWSER_CONTEXT_SHARED');
  },
});
