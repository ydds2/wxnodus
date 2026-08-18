// tests/kernel-loop-judge.test.ts — supremacy 1.5 LLM 辅助循环检测（A-05）：判定器纯函数 + agent 流契约
// 覆盖：loop=提前硬停（比静态阈值更早止损）、progress=复位计数（合法轮询穿过静态硬停阈值）、
// unknown/异常=回退静态提醒→硬停路径、未注入=纯静态（默认关，行为不变）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createAgent, type ModelCall, type ToolCallMsg } from '../src/kernel/agent.js';
import { buildLoopJudgePrompt, parseLoopVerdict, type LoopVerdict } from '../src/kernel/loopJudge.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-loopj-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

const base = (extra: Record<string, any> = {}) => ({
  db, bus, mem, sessionId: 'lj-' + Math.random().toString(36).slice(2, 8),
  config: { settings: { baseURL: 'https://mock', model: 'mock' } } as any,
  mode: 'yolo' as const,
  ...extra,
});

const loopTool = () => ({
  loop_read: { schema: { type: 'function', function: { name: 'loop_read', description: 'loop', parameters: { type: 'object', properties: {} } } }, danger: false, run: async () => 'same output every time' },
});

describe('loopJudge 判定器纯函数', () => {
  it('buildLoopJudgePrompt：含重复次数与最近证据（工具名/参数/输出头部）', () => {
    const { system, user } = buildLoopJudgePrompt(
      [{ name: 'loop_read', args: '{"x":1}', outputHead: 'same output every time' }],
      3,
    );
    expect(system).toContain('loop');
    expect(system).toContain('progress');
    expect(user).toContain('3');
    expect(user).toContain('loop_read');
    expect(user).toContain('same output');
  });
  it('parseLoopVerdict：loop/progress/噪声宽容解析', () => {
    expect(parseLoopVerdict('loop')).toBe('loop');
    expect(parseLoopVerdict('这是死循环 loop')).toBe('loop');
    expect(parseLoopVerdict('PROGRESS 继续')).toBe('progress');
    expect(parseLoopVerdict('无法判断')).toBe('unknown');
    expect(parseLoopVerdict('')).toBe('unknown');
    expect(parseLoopVerdict(null)).toBe('unknown');
  });
});

describe('agent 流：LLM 辅助循环检测（supremacy 1.5）', () => {
  const repeatScript = (toolCalls: number, final: string) => {
    let call = 0;
    return {
      callModel: async (req: { messages: Array<{ role: string; content: any }>; tools?: unknown[] }): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call <= toolCalls) return { type: 'tool_call', name: 'loop_read', args: {} } as ToolCallMsg;
        return { type: 'text', content: final } as ModelCall;
      },
      calls: () => call,
    };
  };

  it('判定 loop → 提醒阈值即提前硬停（不等静态硬停阈值空烧 token）', async () => {
    const evidence: Array<{ repeatCount: number; last: Array<{ name: string }> }> = [];
    const s = repeatScript(8, '不会到达');
    const agent = createAgent(base({
      extraTools: loopTool(),
      callModel: s.callModel,
      loopJudge: async (e: { repeatCount: number; last: Array<{ name: string; args: string; outputHead: string }> }) => {
        evidence.push({ repeatCount: e.repeatCount, last: e.last.map((x: { name: string }) => ({ name: x.name })) });
        return 'loop' as LoopVerdict;
      },
    }));
    const r = await agent.run('死循环');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('LLM 循环判定');
    expect(r.text).toContain('提前终止');
    expect(s.calls()).toBe(2); // 第 2 次重复即判定并终止（静态需 5 次）
    expect(evidence[0]!.repeatCount).toBe(2);
    expect(evidence[0]!.last.map(x => x.name)).toContain('loop_read');
  });

  it('判定 progress → 复位计数：合法轮询穿过静态硬停阈值（6 次重复仍正常完成）', async () => {
    let judgeCalls = 0;
    const s = repeatScript(6, '轮询完成');
    const agent = createAgent(base({
      extraTools: loopTool(),
      callModel: s.callModel,
      loopJudge: async () => { judgeCalls++; return 'progress' as LoopVerdict; },
    }));
    const r = await agent.run('轮询构建');
    expect(r.ok).toBe(true); // 无判定时 6 次重复 ≥5 会硬停——progress 复位后正常完成
    expect(r.text).toBe('轮询完成');
    expect(judgeCalls).toBeGreaterThanOrEqual(3); // 每次爬到提醒阈值重新判定（有界：一次/阈值爬升）
  });

  it('判定 unknown → 回退静态提醒路径（提醒注入、正常完成）', async () => {
    const messages: string[] = [];
    let call = 0;
    const agent = createAgent(base({
      extraTools: loopTool(),
      callModel: async (req: { messages: Array<{ role: string; content: any }> }): Promise<ModelCall | ToolCallMsg> => {
        call++;
        req.messages.forEach(m => { if (typeof m.content === 'string') messages.push(m.content); });
        if (call <= 4) return { type: 'tool_call', name: 'loop_read', args: {} } as ToolCallMsg;
        return { type: 'text', content: '换策略完成' } as ModelCall;
      },
      loopJudge: async () => 'unknown' as LoopVerdict,
    }));
    const r = await agent.run('循环 4 次');
    expect(r.ok).toBe(true);
    expect(messages.some(m => m.includes('【循环提醒】'))).toBe(true);
  });

  it('判定器抛出 → 回退静态路径（不崩溃）', async () => {
    const s = repeatScript(4, '完成');
    const agent = createAgent(base({
      extraTools: loopTool(),
      callModel: s.callModel,
      loopJudge: async () => { throw new Error('判定器挂了'); },
    }));
    const r = await agent.run('循环');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('完成');
  });

  it('未注入 loopJudge（默认关）→ 纯静态路径：5 次重复硬停', async () => {
    const s = repeatScript(6, '不会到达');
    const agent = createAgent(base({
      extraTools: loopTool(),
      callModel: s.callModel,
      // 不传 loopJudge
    }));
    const r = await agent.run('死循环');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('工具调用循环检测');
    expect(r.text).not.toContain('LLM 循环判定');
  });
});
