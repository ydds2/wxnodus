import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createCommandBus } from '../../../src/app/CommandBus.js';
import { GatewayClient } from '../../../src/wxnodus-ui/wxGateway.js';

await runKnownFailureCase({
  failureId: 'KF-002',
  expectedFailureCode: 'CONFIG_FULL_UNREACHABLE',
  assertionMessage: 'CONFIG_FULL_UNREACHABLE',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-002-'));
    const db = openDB(dir);
    try {
      const settings = { model: 'glm-4v-flash', theme: 'wxnodus' };
      const kernel = {
        dataDir: dir, cwd: process.cwd(), db,
        mem: createMemory(db),
        config: { get: () => settings, getKey: (p: string, k: string) => (settings as any)[k] },
        bus: createEventBus(dir), settings, commandBus: createCommandBus(),
        agent: { run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true },
        applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
      };
      const gw = new GatewayClient(kernel as any);
      const r: any = await gw.request('config.get', { key: 'full' });
      // 正确行为：key='full' 返回完整配置快照；当前不可达（返回 undefined 包装）
      assert.ok(r && (r.full || r.settings || typeof r.value === 'object'), 'CONFIG_FULL_UNREACHABLE');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
