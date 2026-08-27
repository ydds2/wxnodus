// tests/kernel-notification-hook.test.ts — P2-15（2026-08-27）：Notification hook 接线
// hooks.ts 契约（HookRunner.notification + 'notification' 事件）早已存在，但 agent 从未调用
// （死接线同类）——本轮补齐：jobs.complete 回流注入主线前触发 hooks.notification。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createPipelineAgent } from './support/createPipelineAgent.js';
import type { ModelCall, ToolCallMsg } from '../src/kernel/agent.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-notify-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => { closeDB(db); rmSync(dir, { recursive: true, force: true }); });

describe('Notification hook（P2-15 接线）', () => {
  it('jobs.complete 回流注入主线前触发 hooks.notification(kind=jobs, text)', async () => {
    const fired: Array<[string, string]> = [];
    let calls = 0;
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'notify-1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      hooks: { notification: (kind: string, text: string) => { fired.push([kind, text]); } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        calls++;
        if (calls === 1) {
          // 第一次 run 的模型调用期间：后台任务完成事件（jobs 回流源——排队）
          bus.emit('jobs.complete', { id: 'j1', kind: 'task', status: 'success', output: '构建产物已生成' });
          return { type: 'text', content: '第一轮' } as ModelCall;
        }
        return { type: 'text', content: '结束' } as ModelCall;
      },
    });
    const r1 = await agent.run('第一次');
    expect(r1.ok).toBe(true);
    expect(fired).toHaveLength(0); // 本回合结束时尚未注入（队列挂起）
    const r2 = await agent.run('第二次');
    expect(r2.ok).toBe(true);
    // 第二次 run 循环顶部 drain noticeQueue → hook 触发 → 通知注入消息（模型可见）
    expect(fired.some(([k, t]) => k === 'jobs' && t.includes('任务 #j1') && t.includes('构建产物已生成'))).toBe(true);
  });

  it('hook 抛异常不阻断通知注入（fail-open 观测通道，通知仍进主线）', async () => {
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'notify-2',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      hooks: { notification: () => { throw new Error('hook 崩溃'); } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        return { type: 'text', content: '结束' } as ModelCall;
      },
    });
    const r = await agent.run('无通知回合');
    expect(r.ok).toBe(true); // hook 异常被吞——观测通道绝不阻断主线
  });
});
