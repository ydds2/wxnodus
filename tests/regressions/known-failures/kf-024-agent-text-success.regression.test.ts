// tests/regressions/known-failures/kf-024-agent-text-success.regression.test.ts — KF-024 已修复回归
// 默认模式：完成声明文本（「完成了」）零验证副作用 → incomplete；普通问答文本不受影响（聊天语义保持）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';

describe('KF-024 resolved: 文本完成声明不经证据不能 ok', () => {
  it('零工具副作用 + 「完成了」→ ok=false 且 status=incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf024r-'));
    const db = openDB(dir);
    try {
      const bus = createEventBus(dir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-024r',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async () => ({ type: 'text', content: '完成了' }),
      });
      const r = await agent.run('完成一个有真实副作用的目标');
      expect(r.ok).toBe(false);
      expect(r.status).toBe('incomplete');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('对照：普通问答文本（非完成声明）→ ok=true（聊天语义不受影响）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf024c-'));
    const db = openDB(dir);
    try {
      const bus = createEventBus(dir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-024c',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async () => ({ type: 'text', content: '你好，我是 wxnodus，可以帮你写代码。' }),
      });
      const r = await agent.run('你好');
      expect(r.ok).toBe(true);
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
