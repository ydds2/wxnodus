// tests/regressions/known-failures/kf-023-goal-verifier-fail-open.regression.test.ts — KF-023 已修复回归
// goal 模式：模型自述 [GOAL_DONE] 只是候选——零验证副作用时必须 incomplete，绝不能 ok。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';

describe('KF-023 resolved: goal 模式完成声明须经确定性验证', () => {
  it('零工具副作用 + [GOAL_DONE] → ok=false 且 status=incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf023r-'));
    const db = openDB(dir);
    try {
      const bus = createEventBus(dir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-023r', mode: 'goal',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async () => ({ type: 'text', content: '任务完成。[GOAL_DONE]' }),
      });
      const r = await agent.run('完成一个需要真实副作用的不可验证目标');
      expect(r.ok).toBe(false);
      expect(r.status).toBe('incomplete');
      // 诚实边界：[GOAL_DONE] 标记仍从文本剥离，交付文本不残留协议标记
      expect(r.text).not.toContain('[GOAL_DONE]');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
