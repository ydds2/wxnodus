import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry } from '../../../src/forge/registry.js';

await runKnownFailureCase({
  failureId: 'KF-017',
  expectedFailureCode: 'FORGE_PLACEHOLDER_VERIFIED',
  assertionMessage: 'FORGE_PLACEHOLDER_VERIFIED',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-017-'));
    try {
      const reg = createRegistry(join(dir, 'registry.json'));
      const id = reg.add({ name: 'ph', kind: 'mcp', source: '/x', version: '1.0.0' });
      // 正确行为：quarantine 不能任意跳转为 verified（须经验证证据）
      reg.setStatus(id, 'verified');
      assert.equal(reg.get(id)!.status, 'quarantine', 'FORGE_PLACEHOLDER_VERIFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
