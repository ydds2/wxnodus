// tests/kernel-agent-gap-2026.test.ts — gap 落地集成面（2026-08-18）
// ① 并行工具调度：纯只读批次并发执行（并发计数实证），含写批次串行（gemini 语义）
// ② 工具输出蒸馏：settings.toolDistill=true 时超阈值输出经二次调用摘要（默认关）
// ③ 硬编码修复：settings.maxTurns 生效（轮次上限可配）；maxContextFor 模型窗口派生
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createAgent, type ModelCall, type ToolCallMsg } from '../src/kernel/agent.js';
import { maxContextFor } from '../src/kernel/providers.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-gap-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

const base = (extra: Record<string, any> = {}) => ({
  db, bus, mem, sessionId: 'gap-' + Math.random().toString(36).slice(2, 8),
  config: { settings: { baseURL: 'https://mock', model: 'mock' } } as any,
  mode: 'yolo' as const,
  ...extra,
});

describe('并行工具调度（danger 读写门）', () => {
  it('纯只读批次并行执行（并发计数实证），结果按槽位保序', async () => {
    let running = 0;
    let maxRunning = 0;
    const slowRead = async (_args: any, _ctx: any) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 40));
      running--;
      return 'read done';
    };
    const messages: Array<Array<{ role: string; content: any }>> = [];
    let call = 0;
    const agent = createAgent(base({
      extraTools: {
        read_a: { schema: { type: 'function', function: { name: 'read_a', description: 'a', parameters: { type: 'object', properties: {} } } }, danger: false, run: slowRead },
        read_b: { schema: { type: 'function', function: { name: 'read_b', description: 'b', parameters: { type: 'object', properties: {} } } }, danger: false, run: slowRead },
      },
      callModel: async (req: { messages: Array<{ role: string; content: any }>; tools?: unknown[] }): Promise<ModelCall | ToolCallMsg> => {
        messages.push(req.messages as any);
        call++;
        if (call === 1) {
          return { type: 'tool_call', name: 'read_a', args: {}, calls: [
            { id: 'c1', name: 'read_a', args: {} },
            { id: 'c2', name: 'read_b', args: {} },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '并行完成' } as ModelCall;
      },
    }));
    const r = await agent.run('跑两个只读');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('并行完成');
    expect(maxRunning).toBe(2); // 只读批次真并行（串行则为 1）
    // 槽位保序：assistant.tool_calls 顺序 = 模型原顺序；两个工具结果齐整
    const assistantMsg = messages[1]!.find(m => (m as any).tool_calls) as any;
    expect(assistantMsg.tool_calls.map((t: any) => t.id)).toEqual(['c1', 'c2']);
    const toolResults = messages[1]!.filter(m => m.role === 'tool').map(m => m.content);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toBe('read done');
    expect(toolResults[1]).toBe('read done');
  });

  it('批次含写工具 → 整批串行（写后读顺序与审批链语义保持）', async () => {
    let running = 0;
    let maxRunning = 0;
    const slowRead = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 40));
      running--;
      return 'read done';
    };
    const slowWrite = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 40));
      running--;
      return 'write done';
    };
    let call = 0;
    const agent = createAgent(base({
      extraTools: {
        read_c: { schema: { type: 'function', function: { name: 'read_c', description: 'c', parameters: { type: 'object', properties: {} } } }, danger: false, run: slowRead },
        write_x: { schema: { type: 'function', function: { name: 'write_x', description: 'w', parameters: { type: 'object', properties: {} } } }, danger: true, run: slowWrite },
      },
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call === 1) {
          return { type: 'tool_call', name: 'write_x', args: {}, calls: [
            { id: 'w1', name: 'write_x', args: {} },
            { id: 'r1', name: 'read_c', args: {} },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '串行完成' } as ModelCall;
      },
    }));
    const r = await agent.run('写+读');
    expect(r.ok).toBe(true);
    expect(maxRunning).toBe(1); // 含写批次整批串行
  });
});

describe('工具输出蒸馏（开关默认关）', () => {
  const big = '数据'.repeat(5000); // 10000 字 > 8000 阈值

  it('toolDistill=true：超阈值输出经二次调用蒸馏并打标', async () => {
    let call = 0;
    const agent = createAgent(base({
      config: { settings: { baseURL: 'https://mock', model: 'mock', toolDistill: true } } as any,
      extraTools: {
        big_read: { schema: { type: 'function', function: { name: 'big_read', description: 'big', parameters: { type: 'object', properties: {} } } }, danger: false, run: async () => big },
      },
      callModel: async (req: { messages: Array<{ role: string; content: any }>; tools?: unknown[] }): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call === 1) return { type: 'tool_call', name: 'big_read', args: {} } as ToolCallMsg;
        if (call === 2) {
          // 蒸馏调用（tools:[]）——返回摘要
          expect((req as any).tools).toHaveLength(0);
          return { type: 'text', content: '摘要：很多数据' } as ModelCall;
        }
        return { type: 'text', content: '收尾' } as ModelCall;
      },
    }));
    const r = await agent.run('读大输出');
    expect(r.ok).toBe(true);
    // 蒸馏结果进历史（第二轮主调用看到 [已蒸馏] 工具结果）
    const toolRow = db.prepare(`SELECT content FROM messages WHERE session_id=? AND role='tool' ORDER BY id DESC LIMIT 1`).get(agent.getSessionId()) as any;
    expect(String(toolRow?.content ?? '')).toContain('[已蒸馏');
  });

  it('toolDistill 缺省 false：不触发蒸馏（原样回填）', async () => {
    let call = 0;
    let secondTools: unknown = 'sentinel';
    const agent = createAgent(base({
      extraTools: {
        big_read2: { schema: { type: 'function', function: { name: 'big_read2', description: 'big', parameters: { type: 'object', properties: {} } } }, danger: false, run: async () => big },
      },
      callModel: async (req: { messages: Array<{ role: string; content: any }>; tools?: unknown[] }): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call === 1) return { type: 'tool_call', name: 'big_read2', args: {} } as ToolCallMsg;
        secondTools = (req as any).tools;
        return { type: 'text', content: '收尾' } as ModelCall;
      },
    }));
    await agent.run('读大输出');
    // 无蒸馏：第二次调用不是 tools:[] 的蒸馏调用（带工具表的主调用）
    expect(secondTools).not.toEqual([]);
  });
});

describe('硬编码修复（gap：生产级无魔法数字）', () => {
  it('settings.maxTurns 生效（轮次上限可配，1..200 夹取）', async () => {
    let call = 0;
    const agent = createAgent(base({
      config: { settings: { baseURL: 'https://mock', model: 'mock', maxTurns: 2 } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        call++;
        // 恒返回未知工具调用 → 轮次耗尽兜底
        return { type: 'tool_call', name: 'no_such_tool_xyz', args: {} } as ToolCallMsg;
      },
    }));
    const r = await agent.run('循环');
    expect(r.turns).toBe(2);
    expect(r.text).toContain('2 轮');
  });

  it('maxContextFor：目录模型窗口派生（64k/128k/256k），未知回退 undefined', () => {
    expect(maxContextFor('deepseek-v4-flash')).toBe(64_000);
    expect(maxContextFor('deepseek-v4-pro')).toBe(128_000);
    expect(maxContextFor('kimi-k3-256k')).toBe(256_000);
    expect(maxContextFor('unknown-model-x')).toBeUndefined();
    expect(maxContextFor(undefined)).toBeUndefined();
  });
});

describe('循环检测分级（gap P1-2：提醒注入→硬停，输出短哈希签名）', () => {
  const loopTool = () => ({
    loop_read: { schema: { type: 'function', function: { name: 'loop_read', description: 'loop', parameters: { type: 'object', properties: {} } } }, danger: false, run: async () => 'same output every time' },
  });

  it('重复 2-4 次只注入换策略提醒（不再 3 次直停误杀合法轮询），正常完成', async () => {
    const messages: string[] = [];
    let call = 0;
    const agent = createAgent(base({
      extraTools: loopTool(),
      callModel: async (req: { messages: Array<{ role: string; content: any }>; tools?: unknown[] }): Promise<ModelCall | ToolCallMsg> => {
        call++;
        req.messages.forEach(m => { if (typeof m.content === 'string') messages.push(m.content); });
        if (call <= 4) return { type: 'tool_call', name: 'loop_read', args: {} } as ToolCallMsg;
        return { type: 'text', content: '换策略后完成' } as ModelCall;
      },
    }));
    const r = await agent.run('循环 4 次');
    expect(r.ok).toBe(true); // 4 次重复未硬停（旧行为 3 次即停）
    expect(r.text).toBe('换策略后完成');
    expect(messages.some(m => m.includes('【循环提醒】'))).toBe(true); // 提醒已注入
  });

  it('重复达到 loopHardStopAt 才硬停——settings.loopHardStopAt=3 恢复旧行为', async () => {
    const agent = createAgent(base({
      extraTools: loopTool(),
      config: { settings: { baseURL: 'https://mock', model: 'mock', loopHardStopAt: 3 } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => ({ type: 'tool_call', name: 'loop_read', args: {} } as ToolCallMsg),
    }));
    const r = await agent.run('死循环');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('工具调用循环检测');
  });

  it('shortHash：确定性 + 输出不同哈希不同（签名并入输出——同参不同输出不漏检）', async () => {
    const { shortHash } = await import('../src/kernel/agent.js');
    expect(shortHash('a')).toBe(shortHash('a'));
    expect(shortHash('a')).toHaveLength(7);
    expect(shortHash('a')).not.toBe(shortHash('b'));
  });
});

describe('goal 模式 chanting 检测（gap P1-2：轮间相同结论空转终止）', () => {
  it('连续相同结论 ≥chantStopAt → 判定空转终止（settings 可调）', async () => {
    let calls = 0;
    const agent = createAgent(base({
      mode: 'goal' as any,
      config: { settings: { baseURL: 'https://mock', model: 'mock', chantStopAt: 3, chantRemindAt: 2, maxGoalRounds: 10 } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        calls++;
        return { type: 'text', content: '同样结论' } as ModelCall;
      },
    }));
    const r = await agent.run('目标', { goalLoop: true });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('空转');
    expect(calls).toBeLessThan(8); // 3+ 轮即终止（远小于 maxGoalRounds 10）
  });
});
