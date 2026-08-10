// tests/kernel-gateway.test.ts — P3：session.undo 响应契约（UI 死路径修复）+ 软归档语义
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '../src/wxnodus-ui/wxGateway.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createMemory } from '../src/kernel/memory.js';
import { createEventBus } from '../src/kernel/events.js';
import { createCommandBus } from '../src/app/CommandBus.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let mem: ReturnType<typeof createMemory>;
let gw: GatewayClient;

function makeGateway() {
  const bus = createEventBus(dir);
  const agent = {
    run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
    abort() {},
    setMode() {},
    getMode: () => 'smart',
    setSessionId() {},
    getSessionId: () => 's1',
    steer: () => true,
  };
  const kernel = {
    dataDir: dir,
    cwd: process.cwd(),
    db,
    mem,
    config: { get: () => ({}), getKey: () => undefined },
    bus,
    settings: {},
    commandBus: createCommandBus(),
    agent,
    applyModel() {},
    setMode() {},
    setTheme() {},
    setThinking() {},
    requestExit() {},
  };
  return new GatewayClient(kernel as any);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-gw-'));
  db = openDB(dir);
  mem = createMemory(db);
  gw = makeGateway();
});

afterEach(() => {
  closeDB(db);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 延迟解锁 */ }
});

describe('session.undo 响应契约（UI 死路径修复）', () => {
  it('空会话返回 { ok:false, removed:0 }', async () => {
    const r = await gw.request('session.undo', { session_id: 's1' });
    expect(r.ok).toBe(false);
    expect(r.removed).toBe(0);
  });

  it('撤销一轮返回 removed=2（user+assistant）且软归档', async () => {
    mem.append('s1', 'user', '问题一');
    mem.append('s1', 'assistant', '回答一');
    mem.append('s1', 'user', '问题二');
    mem.append('s1', 'assistant', '回答二');
    const r = await gw.request('session.undo', { session_id: 's1' });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(2);
    // 软归档：消息仍在库中（黑洞 recall 保留），仅 archived=1
    const archived = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='s1' AND archived=1`).get() as any;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='s1'`).get() as any;
    expect(archived.c).toBe(2);
    expect(total.c).toBe(4);
    // 视图回退：loadMessages 过滤归档 → 只剩第一轮
    const act = await gw.request('session.activate', { session_id: 's1' });
    const view = (act.messages as Array<{ role: string; text: string }>).filter(m => m.role !== 'system');
    expect(view.map(m => m.text)).toEqual(['问题一', '回答一']);
  });

  it('撤销前生成 checkpoint 快照（可恢复）', async () => {
    mem.append('s1', 'user', '问题');
    mem.append('s1', 'assistant', '回答');
    await gw.request('session.undo', { session_id: 's1' });
    const cp = db.prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE session_id='s1'`).get() as any;
    expect(cp.c).toBeGreaterThan(0);
  });

  it('连续撤销直至空（removed 归零不报错）', async () => {
    mem.append('s1', 'user', '唯一问题');
    mem.append('s1', 'assistant', '唯一回答');
    const r1 = await gw.request('session.undo', { session_id: 's1' });
    expect(r1.removed).toBe(2);
    const r2 = await gw.request('session.undo', { session_id: 's1' });
    expect(r2.ok).toBe(false);
    expect(r2.removed).toBe(0);
  });
});
