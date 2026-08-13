import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createTaskRunner } from '../../../src/kernel/taskRunner.js';

await runKnownFailureCase({
  failureId: 'KF-025',
  expectedFailureCode: 'TASK_KILL_EFFECT_CONTINUES',
  assertionMessage: 'TASK_KILL_EFFECT_CONTINUES',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-025-'));
    const db = openDB(dir);
    try {
      let subagentFinished = false;
      const runner = createTaskRunner({
        db, bus: createEventBus(dir), dataDir: dir,
        spawnSubagent: async () => {
          await new Promise(r => setTimeout(r, 2500));
          subagentFinished = true;
          return { ok: true, output: '', turns: 1 };
        },
      });
      const id = runner.run({ kind: 'agent', goal: '长任务', tag: 'kf' });
      await new Promise(r => setTimeout(r, 200));
      await runner.kill(id);
      // 等足子代理完整生命周期（2500ms 任务 + 余量）：kill 后护栏若生效，其副作用永不发生
      await new Promise(r => setTimeout(r, 3200));
      // 正确行为：kill 后 lineage 护栏阻止副作用继续；当前仅更新 DB 状态，子代理继续跑完
      assert.equal(subagentFinished, false, 'TASK_KILL_EFFECT_CONTINUES');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
