import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

await runKnownFailureCase({
  failureId: 'KF-029',
  expectedFailureCode: 'ENGLISH_PROMPT_CHINESE_CONTROL_TEXT',
  assertionMessage: 'ENGLISH_PROMPT_CHINESE_CONTROL_TEXT',
  run: async () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/systemPrompt.ts'), 'utf8');
    // 正确行为：lang=en 时控制文本（规则/护栏描述）全英文；当前仍混入中文控制文本
    const hasZh = /[\u4e00-\u9fff]/.test(src);
    assert.equal(hasZh, false, 'ENGLISH_PROMPT_CHINESE_CONTROL_TEXT');
  },
});
