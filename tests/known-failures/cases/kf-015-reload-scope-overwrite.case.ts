import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';
import type { ToolDef } from '../../../src/kernel/tools.js';

await runKnownFailureCase({
  failureId: 'KF-015',
  expectedFailureCode: 'REGISTRATION_SCOPE_OVERWRITE',
  assertionMessage: 'REGISTRATION_SCOPE_OVERWRITE',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-015-'));
    const db = openDB(dir);
    try {
      const bus = createEventBus(dir);
      const mem = createMemory(db);
      const mkTool = (name: string, stamp: string): ToolDef => ({
        schema: { type: 'function', function: { name, description: stamp, parameters: { type: 'object', properties: {} } } },
        danger: false,
        run: async () => stamp,
      });
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-015',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async () => ({ type: 'tool_call', name: 'hotplug_a', args: {} }),
      });
      // 两次 updateTools 各注册一个工具——正确行为：各自 scope 合并共存
      agent.updateTools({ hotplug_a: mkTool('hotplug_a', 'A') });
      agent.updateTools({ hotplug_b: mkTool('hotplug_b', 'B') });
      const r = await agent.run('调用 hotplug_a');
      // 当前实现整体重建工具表，第二次 updateTools 覆盖第一次注册（调用回填「不存在」）
      assert.ok(!r.text.includes('未知工具'), 'REGISTRATION_SCOPE_OVERWRITE');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
