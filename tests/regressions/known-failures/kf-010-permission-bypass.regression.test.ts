// tests/regressions/known-failures/kf-010-permission-bypass.regression.test.ts — KF-010 已修复回归
// manual 模式 + 未提供 onApproval：fs_write 工作区外必须 fail-closed 拒绝（默认审批绝不放行）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';

describe('KF-010 resolved: manual 模式默认审批 fail-closed', () => {
  it('无 onApproval 时工作区外 fs_write 被拒绝（文件不创建）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf010r-'));
    const outside = join(dir, 'outside.txt');
    const db = openDB(dir);
    try {
      const bus = createEventBus(dir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-010r', mode: 'manual',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async () => ({ type: 'tool_call', name: 'fs_write', args: { path: outside, content: 'x' } }),
      });
      const r = await agent.run('写工作区外文件');
      void r;
      // 安全真相：区外文件绝不创建（默认审批 fail-closed；拒绝结果以「用户拒绝执行」回填模型）
      expect(existsSync(outside)).toBe(false);
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
