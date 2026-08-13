import { runKnownFailureCase } from '../caseHarness.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

await runKnownFailureCase({
  failureId: 'KF-009',
  expectedFailureCode: 'UIA_ACTION_FALSE_SUCCESS',
  assertionMessage: 'UIA_ACTION_FALSE_SUCCESS',
  run: async () => {
    // 静态合同断言（确定性、无桌面副作用）：点击兜底分支只计算中心坐标，
    // 却以 ok:true/method=focus 谎报动作已执行——从未真实点击或诚实报错
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/computer/uia.ts'), 'utf8');
    const start = src.indexOf('click: `');
    const end = src.indexOf('type: `', start);
    const clickBlock = start >= 0 ? src.slice(start, end > 0 ? end : start + 3000) : '';
    assert.equal(/focus/.test(clickBlock), false, 'UIA_ACTION_FALSE_SUCCESS');
  },
});
