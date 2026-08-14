// tests/regressions/known-failures/kf-015-registration-scope-overwrite.regression.test.ts — KF-015 迁移绿回归
// 契约：agent.updateTools 增量合并——多次注册各自 scope 共存（绝不整体重建覆盖先前注册）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-kf-015-')); tempDirs.push(d); return d; };

describe('KF-015 resolved: updateTools 增量合并注册', () => {
  it('两次 updateTools 注册的工具共存——调用先前注册的工具不再「未知工具」', async () => {
    const dir = tmp();
    const db = openDB(dir);
    const bus = createEventBus(dir);
    const mem = createMemory(db);
    try {
      const calls: string[] = [];
      const mkTool = (name: string, stamp: string) => ({
        schema: { type: 'function' as const, function: { name, description: stamp, parameters: { type: 'object' as const, properties: {} } } },
        danger: false,
        run: async () => { calls.push(stamp); return stamp; },
      });
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-015',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: (() => {
          let n = 0;
          return async () => (n++ === 0 ? { type: 'tool_call', name: 'hotplug_a', args: {} } : { type: 'text', content: 'done' });
        })(),
      });
      agent.updateTools({ hotplug_a: mkTool('hotplug_a', 'A') });
      agent.updateTools({ hotplug_b: mkTool('hotplug_b', 'B') });
      const r = await agent.run('调用 hotplug_a');
      expect(r.text).not.toContain('未知工具');
      expect(calls).toContain('A');
    } finally { closeDB(db); }
  });

  it('同名重注册按后注册覆盖（热重载语义保持）', async () => {
    const dir = tmp();
    const db = openDB(dir);
    const bus = createEventBus(dir);
    const mem = createMemory(db);
    try {
      const calls: string[] = [];
      let n = 0;
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-015b',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        // 一次工具调用后回文本——避免工具调用循环检测干扰断言
        callModel: async () => (n++ === 0 ? { type: 'tool_call', name: 'hotplug_a', args: {} } : { type: 'text', content: 'done' }),
      });
      agent.updateTools({ hotplug_a: { schema: { type: 'function' as const, function: { name: 'hotplug_a', description: 'v1', parameters: { type: 'object' as const, properties: {} } } }, danger: false, run: async () => { calls.push('v1'); return 'v1'; } } });
      agent.updateTools({ hotplug_a: { schema: { type: 'function' as const, function: { name: 'hotplug_a', description: 'v2', parameters: { type: 'object' as const, properties: {} } } }, danger: false, run: async () => { calls.push('v2'); return 'v2'; } } });
      await agent.run('调用 hotplug_a');
      expect(calls).toEqual(['v2']); // 执行的是后注册版本（覆盖生效）
    } finally { closeDB(db); }
  });
});
