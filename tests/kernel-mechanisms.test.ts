// tests/kernel-mechanisms.test.ts — 机制补强：自动压缩/自动标题/curator 间隔
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateMessagesTokens, compactMessages, createMemory } from '../src/kernel/memory.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { curatorConfigFrom, readCuratorState, writeCuratorState, maybeRunCurator } from '../src/kernel/curator.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-mech-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('自动压缩（内存消息）', () => {
  it('estimateMessagesTokens 估算消息序列', () => {
    const msgs = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '世界' },
    ];
    const t = estimateMessagesTokens(msgs);
    expect(t).toBeGreaterThanOrEqual(4); // 2 CJK 字 + 2 条角色开销
    expect(estimateMessagesTokens([])).toBe(0);
  });
  it('compactMessages LLM 摘要：保头尾 + 摘要', async () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }));
    const out = await compactMessages(msgs, async () => '中间内容摘要');
    expect(out[0]!.content).toBe('消息0');
    expect(out[1]!.content).toBe('消息1');
    expect(out[2]!.content).toBe('消息2');
    expect(out.some(m => m.role === 'system' && m.content.includes('摘要'))).toBe(true);
    expect(out.at(-1)!.content).toBe('消息19');
    expect(out.length).toBeLessThan(msgs.length);
  });
  it('compactMessages 摘要失败降级为确定性截断（不抛错）', async () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }));
    const out = await compactMessages(msgs, async () => { throw new Error('模拟失败'); });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.content).toBe('消息0');
  });
  it('短消息序列不压缩', async () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const out = await compactMessages(msgs, async () => 'x');
    expect(out.length).toBe(6);
  });
});

describe('自动标题', () => {
  it('setTitleIfEmpty 仅填空标题', () => {
    const db = openDB(dir);
    const mem = createMemory(db);
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', '', 1, 1)`).run();
    mem.setTitleIfEmpty('s1', '我的会话');
    expect((db.prepare(`SELECT title FROM sessions WHERE id='s1'`).get() as { title: string }).title).toBe('我的会话');
    mem.setTitleIfEmpty('s1', '不应覆盖');
    expect((db.prepare(`SELECT title FROM sessions WHERE id='s1'`).get() as { title: string }).title).toBe('我的会话');
    closeDB(db);
  });
});

describe('curator 间隔审查', () => {
  it('配置解析与状态读写', () => {
    expect(curatorConfigFrom(undefined)).toEqual({ enabled: true, intervalHours: 24 });
    expect(curatorConfigFrom({ curator: { enabled: false, intervalHours: 3 } })).toEqual({ enabled: false, intervalHours: 3 });
    expect(readCuratorState(dir)).toEqual({ lastRunAt: null });
    writeCuratorState(dir, { lastRunAt: 123 });
    expect(readCuratorState(dir)).toEqual({ lastRunAt: 123 });
  });
  it('maybeRunCurator 超期执行、未超期跳过（幂等）', () => {
    const db = openDB(dir);
    const mem = createMemory(db);
    const bus = createEventBus(dir);
    const notices: string[] = [];
    bus.on('system.notice', (e: any) => notices.push(String(e.payload?.text ?? '')));
    let settings: Record<string, any> = { curator: { enabled: true, intervalHours: 24 } };
    // 从未运行 → 执行
    maybeRunCurator({ getSettings: () => settings, mem, dataDir: dir, cwd: dir, bus });
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('[curator]');
    // 刚运行 → 跳过
    maybeRunCurator({ getSettings: () => settings, mem, dataDir: dir, cwd: dir, bus });
    expect(notices.length).toBe(1);
    // 禁用 → 跳过
    settings = { curator: { enabled: false, intervalHours: 24 } };
    maybeRunCurator({ getSettings: () => settings, mem, dataDir: dir, cwd: dir, bus });
    expect(notices.length).toBe(1);
    closeDB(db);
  });
});
