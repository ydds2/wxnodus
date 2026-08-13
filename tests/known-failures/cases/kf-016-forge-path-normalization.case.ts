import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgeSkillDir } from '../../../src/forge/forge.js';

await runKnownFailureCase({
  failureId: 'KF-016',
  expectedFailureCode: 'FORGE_PATH_DOUBLE_JOIN',
  assertionMessage: 'FORGE_PATH_DOUBLE_JOIN',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-016-'));
    try {
      // 调用方已按组件名建目录，forge 内部再次 join 组件名 → 路径双拼
      const composed = join(dir, 'my-skill');
      forgeSkillDir(composed, 'my-skill', '描述', '流程');
      assert.equal(existsSync(join(dir, 'my-skill', 'SKILL.md')), true, 'FORGE_PATH_DOUBLE_JOIN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
