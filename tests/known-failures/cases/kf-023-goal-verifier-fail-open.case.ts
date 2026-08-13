import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';

await runKnownFailureCase({
  failureId: 'KF-023',
  expectedFailureCode: 'GOAL_VERIFIER_FAIL_OPEN',
  assertionMessage: 'GOAL_VERIFIER_FAIL_OPEN',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-023-'));
    const db = openDB(dir);
    try {
      const bus = createEventBus(dir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-023', mode: 'goal',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async () => ({ type: 'text', content: '任务完成。[GOAL_DONE]' }),
      });
      const r = await agent.run('完成一个需要真实副作用的不可验证目标');
      // 正确行为：模型自述 [GOAL_DONE] 只是候选，须经确定性验证才可 ok；当前直接采信
      assert.equal(r.ok, false, 'GOAL_VERIFIER_FAIL_OPEN');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
