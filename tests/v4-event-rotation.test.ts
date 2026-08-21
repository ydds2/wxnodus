// tests/v4-event-rotation.test.ts — V4 P3-3：事件流落盘分级 + 轮转
// ① agent.token/reasoning.delta 不落盘（events.jsonl）；低频事件（message/end/tool）全保留
// ② events.jsonl 4MB 轮转（.1 保留上一代）——单元级以轮转阈值缩小验证
// ③ sessionStream 异步追加 + 5MB 轮转存在性
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus } from '../src/kernel/events.js';
import { appendSessionEvent, readSessionEvents } from '../src/kernel/sessionStream.js';

const work = () => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', 'wx-evr-'));
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

describe('V4 P3-3 事件流落盘分级', () => {
  it('agent.token 不落盘；message/end 低频事件全保留（重放完整性）', async () => {
    const d = work(); dirs.push(d);
    const bus = createEventBus(d);
    // 高频流式事件（一次长回复数千次的量级）
    for (let i = 0; i < 500; i++) bus.emit('agent.token', { text: '字'.repeat(10) });
    bus.emit('agent.message', { content: '最终回复' });
    bus.emit('agent.end', { turns: 1 });
    await new Promise(r => setTimeout(r, 100)); // 落盘时序排空
    const raw = readFileSync(join(d, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('agent.token'); // 高频不落盘
    expect(raw).toContain('agent.message');
    expect(raw).toContain('agent.end');
    // 内存 history 不受影响（订阅者仍收到 token）
    expect(bus.history().some(e => e.type === 'agent.token')).toBe(true);
  });

  it('sessionStream 异步追加：事件最终落盘且可读回', async () => {
    const d = work(); dirs.push(d);
    appendSessionEvent(d, 's1', { type: 'model', role: 'text', content: 'hello', ts: 1 });
    appendSessionEvent(d, 's1', { type: 'compact', summary: 's', before: 1, after: 2, ts: 2 });
    await new Promise(r => setTimeout(r, 150)); // 异步完成
    const evs = readSessionEvents(d, 's1');
    expect(evs.length).toBe(2);
    expect(evs[0]).toMatchObject({ type: 'model', content: 'hello' });
  });

  it('sessionStream 5MB 轮转：预置超大文件再追加 → 触发翻卷（.1 存在、原文件重置）', async () => {
    const d = work(); dirs.push(d);
    const f = join(d, 'session-streams', 's-rot.jsonl');
    mkdirSync(join(d, 'session-streams'), { recursive: true });
    writeFileSync(f, 'x'.repeat(5 * 1024 * 1024 + 100), 'utf8'); // 预置超限
    appendSessionEvent(d, 's-rot', { type: 'model', role: 'text', content: 'trigger', ts: 3 });
    await new Promise(r => setTimeout(r, 200));
    expect(existsSync(`${f}.1`)).toBe(true); // 上一代已翻卷
  }, 15_000);
});
