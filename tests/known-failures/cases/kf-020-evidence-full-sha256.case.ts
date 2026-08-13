import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../../../src/build/evidence.js';

await runKnownFailureCase({
  failureId: 'KF-020',
  expectedFailureCode: 'EVIDENCE_WEAK_FINGERPRINT',
  assertionMessage: 'EVIDENCE_WEAK_FINGERPRINT',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-020-'));
    try {
      writeFileSync(join(dir, 'a.txt'), '内容');
      const fp = fingerprint(dir);
      // 正确行为：证据指纹为完整 SHA-256（64 hex）；当前截断到 6 hex，碰撞空间不可接受
      assert.equal(fp.length, 64, 'EVIDENCE_WEAK_FINGERPRINT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
