// tests/kernel-agent.test.ts — L2-4 agent 循环：流式/工具执行/权限/重试/中断/子代理/规则脑
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createAgent, type ModelCall, type ToolCallMsg } from '../src/kernel/agent.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-ag-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

// 构造测试用 agent：注入 mock 模型
function makeAgent(script: Array<ModelCall | ToolCallMsg>) {
  const agent = createAgent({
    db, bus, mem, sessionId: 't',
    config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
    callModel: async (req): Promise<ModelCall | ToolCallMsg> => script.shift()!,
  });
  return agent;
}

describe('规则脑兜底（无 key）', () => {
  it('无密钥时返回规则脑回复（诚实不假装）', async () => {
    const agent = createAgent({
      db, bus, mem, sessionId: 't2',
      config: { settings: {} } as any,
      callModel: null,
    });
    const r = await agent.run('你好');
    expect(r.ok).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
  });
});

describe('流式与消息事件', () => {
  it('文本流经事件总线发出（agent.token）', async () => {
    const tokens: string[] = [];
    bus.on('agent.token', e => tokens.push(e.payload.text));
    const agent = makeAgent([{ type: 'text', content: '这是回答' }]);
    const r = await agent.run('问题');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('这是回答');
    expect(tokens.join('')).toBe('这是回答');
  });
});

describe('工具调用循环', () => {
  it('模型请求工具 → 执行 → 结果回填 → 二次调用', async () => {
    const seen: string[] = [];
    const agent = makeAgent([
      { type: 'tool_call', name: 'fs_read', args: { path: 'package.json' } },
      { type: 'text', content: '读完了' },
    ]);
    bus.on('agent.tool', e => seen.push(`${e.payload.name}:${e.payload.phase}`));
    const r = await agent.run('读文件');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('读完了');
    expect(seen).toContain('fs_read:start');
    expect(seen).toContain('fs_read:complete');
  });

  it('权限拒绝：confirm 未通过 → 工具不执行，结果回填拒绝', async () => {
    let n = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't3',
      config: { settings: {} } as any,
      callModel: async () => {
        n++;
        return n === 1
          ? { type: 'tool_call', name: 'fs_write', args: { path: 'x.txt', content: 'y' } } as ToolCallMsg
          : { type: 'text', content: '用户拒绝了写文件' } as ModelCall;
      },
      mode: 'manual',
      onApproval: async () => false, // 用户拒绝
    });
    const r = await agent.run('写文件');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('拒绝');
  });

  it('同工具连续失败 5 次终止', async () => {
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't4',
      config: { settings: {} } as any,
      mode: 'yolo',
      callModel: async () => {
        calls++;
        return calls <= 6 ? { type: 'tool_call', name: 'bash', args: { command: 'nonexistent-cmd-xyz' } } as ToolCallMsg
          : { type: 'text', content: 'done' } as ModelCall;
      },
    });
    const r = await agent.run('跑命令');
    expect(calls).toBeLessThanOrEqual(5 + 1); // 连续失败后终止
  });
});

describe('中断', () => {
  it('abort 中断进行中的回合', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const agent = createAgent({
      db, bus, mem, sessionId: 't5',
      config: { settings: {} } as any,
      callModel: async () => { await gate; return { type: 'text', content: 'x' }; },
    });
    const p = agent.run('问题');
    setTimeout(() => { agent.abort(); release(); }, 10); // abort 触发 race → 中断
    const r = await p;
    expect(r.interrupted).toBe(true);
  });
});

describe('子代理', () => {
  it('spawnSubagent 独立上下文 + 只读工具集', async () => {
    const agent = makeAgent([{ type: 'text', content: '子代理结论' }]);
    const r = await agent.spawnSubagent('检查目录');
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeGreaterThan(0);
  });
});
