import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';

await runKnownFailureCase({
  failureId: 'KF-010',
  expectedFailureCode: 'MANUAL_PATH_PERMISSION_BYPASS',
  assertionMessage: 'MANUAL_PATH_PERMISSION_BYPASS',
  run: async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'wxn-kf-010-'));
    const outside = join(fixtureDir, 'outside.txt');
    const db = openDB(fixtureDir);
    try {
      const bus = createEventBus(fixtureDir);
      const mem = createMemory(db);
      // manual 模式 + 无 onApproval：fs_write 工作区外必须被拒绝；当前默认 onApproval=()=>true 直接放行
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-010', mode: 'manual',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async () => ({ type: 'tool_call', name: 'fs_write', args: { path: outside, content: 'x' } }),
      });
      await agent.run('写工作区外文件');
      assert.equal(existsSync(outside), false, 'MANUAL_PATH_PERMISSION_BYPASS');
    } finally {
      closeDB(db);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
});
