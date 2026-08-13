import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';

await runKnownFailureCase({
  failureId: 'KF-003',
  expectedFailureCode: 'SETUP_WIZARD_NOT_ENTERED',
  assertionMessage: 'SETUP_WIZARD_NOT_ENTERED',
  run: async () => {
    // 正确行为：首次安装必须进入 zh/en 引导（R13 bootstrap）；当前不存在该模块
    const mod = await import('../../../src/bootstrap/setupWizard.js').catch(() => null);
    assert.ok(mod !== null, 'SETUP_WIZARD_NOT_ENTERED');
  },
});
