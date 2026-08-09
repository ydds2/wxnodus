// tests/kernel-events.test.ts — L1-3 事件总线：发布订阅 / 持久化 / 审计
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus, type WxEvent } from '../src/kernel/events.js';

let dir: string;
let bus: ReturnType<typeof createEventBus>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-evt-'));
  bus = createEventBus(dir);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('发布订阅', () => {
  it('订阅收到事件（含 payload）', () => {
    const got: WxEvent[] = [];
    const off = bus.on('agent.token', e => got.push(e));
    bus.emit('agent.token', { text: '你' });
    bus.emit('agent.token', { text: '好' });
    expect(got.length).toBe(2);
    expect(got[0].payload.text).toBe('你');
    off();
    bus.emit('agent.token', { text: 'x' });
    expect(got.length).toBe(2); // 退订后不再收
  });

  it('多订阅者独立收到', () => {
    let a = 0, b = 0;
    bus.on('agent.stage', () => a++);
    bus.on('agent.stage', () => b++);
    bus.emit('agent.stage', { stage: 'work' });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('未订阅事件不报错', () => {
    expect(() => bus.emit('nonexistent', {})).not.toThrow();
  });
});

describe('持久化', () => {
  it('事件 append-only 落盘 jsonl', () => {
    bus.emit('agent.tool', { name: 'bash', phase: 'start' });
    bus.emit('agent.tool', { name: 'bash', phase: 'complete', ok: true });
    const f = join(dir, 'events.jsonl');
    expect(existsSync(f)).toBe(true);
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.type).toBe('agent.tool');
    expect(last.payload.ok).toBe(true);
  });

  it('事件含 id/ts 元数据', () => {
    const f = join(dir, 'events.jsonl');
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    expect(typeof first.id).toBe('string');
    expect(typeof first.ts).toBe('number');
  });
});

describe('回放（重放历史事件）', () => {
  it('history() 返回已发事件', () => {
    const h = bus.history();
    expect(h.length).toBeGreaterThan(0);
    expect(h.some(e => e.type === 'agent.stage')).toBe(true);
  });
});
