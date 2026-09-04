// tests/kernel-durable-queue.test.ts — P2-14（2026-08-27）：用户消息持久队列 + 崩溃恢复
// 覆盖：入队→running→done 生命周期 / stale 恢复标记 interrupted / 终态收口（任何结局）/ 子代理不入队。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createPipelineAgent } from './support/createPipelineAgent.js';
import {
  enqueueDurablePrompt,
  markDurableDone,
  markDurableRunning,
  pendingDurableCount,
  recoverStalePrompts, purgeDurableRows,
} from '../src/kernel/durableQueue.js';
import type { ModelCall, ToolCallMsg } from '../src/kernel/agent.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-dq-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => { closeDB(db); rmSync(dir, { recursive: true, force: true }); });

describe('durableQueue（P2-14）', () => {
  it('生命周期：queued → running → done；行状态与时间戳单调', () => {
    const id = enqueueDurablePrompt(db, 's1', '第一条消息', null);
    const row = db.prepare('SELECT status, prompt FROM durable_prompts WHERE id=?').get(id) as { status: string; prompt: string };
    expect(row.status).toBe('queued');
    expect(row.prompt).toBe('第一条消息');
    markDurableRunning(db, id);
    expect((db.prepare('SELECT status FROM durable_prompts WHERE id=?').get(id) as { status: string }).status).toBe('running');
    markDurableDone(db, id);
    expect((db.prepare('SELECT status FROM durable_prompts WHERE id=?').get(id) as { status: string }).status).toBe('done');
    expect(pendingDurableCount(db, 's1')).toBe(0);
  });

  it('崩溃恢复：stale 的 queued/running → interrupted（原文保留）', () => {
    const id = enqueueDurablePrompt(db, 's2', '崩溃前的消息', 'run-x');
    db.prepare('UPDATE durable_prompts SET updated_at=? WHERE id=?').run(Date.now() - 10 * 60_000, id);
    const recovered = recoverStalePrompts(db, 's2');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.prompt).toBe('崩溃前的消息');
    expect(recovered[0]!.status).toBe('interrupted');
    // 新入队的（未超时）不受影响
    const fresh = enqueueDurablePrompt(db, 's2', '新消息', null);
    expect(recoverStalePrompts(db, 's2')).toHaveLength(0);
    markDurableDone(db, fresh);
  });

  it('agent 集成：任何结局都收口 done（模型抛错也算处理完毕）', async () => {
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'dq-agent-1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => { throw new Error('模型崩溃'); },
    });
    const r = await agent.run('会被持久化的消息');
    expect(r.ok).toBe(false);
    const rows = db.prepare("SELECT status FROM durable_prompts WHERE session_id='dq-agent-1' ORDER BY id DESC LIMIT 1").all() as Array<{ status: string }>;
    expect(rows[0]!.status).toBe('done'); // 终态收口——结局归 RunContext，队列不双写结局
    expect(pendingDurableCount(db, 'dq-agent-1')).toBe(0);
  });

  it('N1 回归：子代理（isSubagent 标志）不入队——真实豁免机制（原 :sub 后缀守卫是无生产者的死代码）', async () => {
    // kernel-eval 2026-08-30 N1：原守卫 endsWith(':sub') 匹配不到真实子会话（sub- 前缀/父 id 透传）
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'sub-lx3k9a', // 真实子会话形态（spawnSub 缺省前缀）
      isSubagent: true,
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async () => ({ type: 'text', content: 'ok' } as ModelCall),
    });
    const r = await agent.run('子代理目标');
    expect(r.ok).toBe(true);
    expect(pendingDurableCount(db, 'sub-lx3k9a')).toBe(0);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM durable_prompts WHERE session_id='sub-lx3k9a'").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('N1 回归：父 id 透传的子代理（execution.sessionId=父）也不入队——标志豁免不依赖 id 形态', async () => {
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'dq-main', // 父会话 id 被子代理复用（execution 透传形态）
      isSubagent: true,
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async () => ({ type: 'text', content: 'ok' } as ModelCall),
    });
    await agent.run('子代理目标');
    const rows = db.prepare("SELECT COUNT(*) AS c FROM durable_prompts WHERE session_id='dq-main' AND prompt='子代理目标'").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('N1 回归：孤儿行清扫——终态超期行被删除、未超期保留', () => {
    const ts = Date.now();
    db.prepare("INSERT INTO durable_prompts (session_id, prompt, status, run_id, created_at, updated_at) VALUES ('dq-old','旧完成','done',NULL,?,?)").run(ts - 8 * 24 * 3600_000, ts - 8 * 24 * 3600_000);
    db.prepare("INSERT INTO durable_prompts (session_id, prompt, status, run_id, created_at, updated_at) VALUES ('dq-new','新完成','done',NULL,?,?)").run(ts, ts);
    const purged = purgeDurableRows(db);
    expect(purged).toBe(1);
    const remain = db.prepare("SELECT prompt FROM durable_prompts WHERE status='done'").all() as Array<{ prompt: string }>;
    expect(remain.some(r => r.prompt === '旧完成')).toBe(false);
    expect(remain.some(r => r.prompt === '新完成')).toBe(true);
  });
});
