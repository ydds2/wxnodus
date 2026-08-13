import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSpec } from '../../../src/build/spec.js';
import { instantiate } from '../../../src/build/scaffold.js';

await runKnownFailureCase({
  failureId: 'KF-018',
  expectedFailureCode: 'BUILD_STATIC_FRONTEND_MISSING',
  assertionMessage: 'BUILD_STATIC_FRONTEND_MISSING',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-018-'));
    try {
      const spec = makeSpec('帮我做一个待办系统', { key: null });
      instantiate(spec, dir);
      // 正确行为：脚手架交付可静态部署的前端产物；当前缺失 index.html/静态构建输出
      const hasStatic = existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'dist', 'index.html')) || existsSync(join(dir, 'static'));
      assert.equal(hasStatic, true, 'BUILD_STATIC_FRONTEND_MISSING');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
