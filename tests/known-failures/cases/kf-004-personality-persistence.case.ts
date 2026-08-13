import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { unknownSettingsKeys } from '../../../src/store/config.js';

await runKnownFailureCase({
  failureId: 'KF-004',
  expectedFailureCode: 'PERSONALITY_FALSE_SUCCESS',
  assertionMessage: 'PERSONALITY_FALSE_SUCCESS',
  run: async () => {
    // /personality 写入 settings.personality 并宣称成功——但该键不在配置 schema 白名单，
    // 属 false success（写入被 /config set 校验为未知键，从未进入任何消费路径）
    const unknown = unknownSettingsKeys({ personality: 'concise' });
    assert.deepEqual(unknown, [], 'PERSONALITY_FALSE_SUCCESS');
  },
});
