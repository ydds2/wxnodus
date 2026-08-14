// tests/regressions/known-failures/kf-025-task-kill-effect-fence.regression.test.ts — KF-025 正式回归
// kill 后 agent 线通过 AbortSignal 撤销子代理：子代理不得继续跑完并产生副作用；
// 任务状态保持 cancelled，不得被迟到的子代理结果覆盖。KF-025 case 已退役，本文件是唯一权威回归。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createTaskRunner } from '../../../src/kernel/taskRunner.js';

describe('KF-025 task kill effect fence regression', () => {
  it('aborts the subagent on kill so its side effects never happen and cancelled is never overwritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-025-regression-'));
    const db = openDB(dir);
    try {
      let subagentFinished = false;
      let abortObserved = false;
      const runner = createTaskRunner({
        db,
        bus: createEventBus(dir),
        dataDir: dir,
        spawnSubagent: async (_goal, signal) => {
          const aborted = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => resolve(false), 2500);
            signal?.addEventListener('abort', () => {
              abortObserved = true;
              clearTimeout(timer);
              resolve(true);
            }, { once: true });
            if (signal?.aborted) {
              abortObserved = true;
              clearTimeout(timer);
              resolve(true);
            }
          });
          if (!aborted) subagentFinished = true;
          return { ok: true, output: '', turns: 1 };
        },
      });
      const id = runner.run({ kind: 'agent', goal: '长任务', tags: ['kf'] });
      await new Promise(r => setTimeout(r, 200));
      await runner.kill(id);
      // 等足旧实现的完整生命周期（2500ms 任务 + 余量）：abort 生效则副作用永不发生
      await new Promise(r => setTimeout(r, 3200));

      expect(abortObserved).toBe(true);
      expect(subagentFinished).toBe(false);
      expect(runner.get(id)?.status).toBe('cancelled');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
