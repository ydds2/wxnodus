import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { captureScreen } from '../../../src/kernel/computer/index.js';

await runKnownFailureCase({
  failureId: 'KF-007',
  expectedFailureCode: 'SCREENSHOT_DIMENSION_API_MISMATCH',
  assertionMessage: 'SCREENSHOT_DIMENSION_API_MISMATCH',
  run: async () => {
    const shot = await captureScreen();
    if (!shot) throw new Error('NO_DESKTOP_CAPTURE');
    // 正确行为：返回真实像素宽高（正整数）；当前读取 Monitor 上不存在的 width/height 属性
    assert.ok(Number.isFinite(shot.width) && shot.width > 0 && Number.isFinite(shot.height) && shot.height > 0, 'SCREENSHOT_DIMENSION_API_MISMATCH');
  },
});
