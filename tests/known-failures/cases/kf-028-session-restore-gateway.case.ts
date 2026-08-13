import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

await runKnownFailureCase({
  failureId: 'KF-028',
  expectedFailureCode: 'SESSION_RESTORE_DEFAULTED',
  assertionMessage: 'SESSION_RESTORE_DEFAULTED',
  run: async () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/cli/index.ts'), 'utf8');
    const resumeBlock = src.split('pickResumeSession')[1] ?? '';
    // 正确行为：恢复会话后，Gateway/UI 必须绑定恢复的 sessionId（经 agent.getSessionId），不得回落 default
    assert.ok(/getSessionId/.test(resumeBlock) && /getSessionId/.test(src.split('pickResumeSession')[1] ?? ''), 'SESSION_RESTORE_DEFAULTED');
  },
});
