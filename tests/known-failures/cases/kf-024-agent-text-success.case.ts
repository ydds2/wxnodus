import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent, type ModelCall } from '../../../src/kernel/agent.js';

await runKnownFailureCase({
  failureId: 'KF-024',
  expectedFailureCode: 'AGENT_TEXT_FALSE_SUCCESS',
  assertionMessage: 'AGENT_TEXT_FALSE_SUCCESS',
  run: async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'wxn-kf-024-'));
    const db = openDB(fixtureDir);
    try {
      const bus = createEventBus(fixtureDir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-024',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async (): Promise<ModelCall> => ({ type: 'text', content: '完成了' }),
      });
      const result = await agent.run('执行一个不可验证的真实副作用');
      assert.equal(result.ok, false, 'AGENT_TEXT_FALSE_SUCCESS');
    } finally {
      closeDB(db);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
});
