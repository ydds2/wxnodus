import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus } from '../../../src/kernel/events.js';
import { createHookRunner } from '../../../src/kernel/hooks.js';

await runKnownFailureCase({
  failureId: 'KF-026',
  expectedFailureCode: 'SECURITY_HOOK_FAIL_OPEN',
  assertionMessage: 'SECURITY_HOOK_FAIL_OPEN',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-026-'));
    try {
      const runner = createHookRunner(
        () => ({ hooks: { preToolUse: 'node -e "process.exit(1)"' } }),
        createEventBus(dir),
      );
      // 正确行为：安全 hook 崩溃/超时必须 fail-closed（拦截工具）；当前空输出→放行
      const allowed = await runner.preToolUse('fs_write', { path: 'x' });
      assert.equal(allowed, false, 'SECURITY_HOOK_FAIL_OPEN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
