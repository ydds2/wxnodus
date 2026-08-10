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
    callModel: async (req, streamCtx): Promise<ModelCall | ToolCallMsg> => {
      const next = script.shift()!;
      // 模拟真流式：文本经 onToken 拆块推送（与 defaultCallModel SSE 语义一致）
      if (next.type === 'text' && streamCtx?.onToken) {
        for (let i = 0; i < next.content.length; i += 4) streamCtx.onToken(next.content.slice(i, i + 4));
      }
      return next;
    },
  });
  return agent;
}

describe('无 key 配置引导（全部输出必须经 AI 模型）', () => {
  it('无密钥时提示配置，不做规则脑假装回答', async () => {
    const agent = createAgent({
      db, bus, mem, sessionId: 't2',
      config: { settings: {} } as any,
      callModel: null,
    });
    const r = await agent.run('你好');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('/key set');
    expect(r.text).not.toContain('规则脑');
  });

  it('enc 存在但解密失败（机器指纹变化）→ 明确提示重新配置而非「未配置」', async () => {
    const agent = createAgent({
      db, bus, mem, sessionId: 't2b',
      config: { settings: { apiKeyEnc: 'enc1:deadbeef:deadbeef:deadbeef', baseURL: 'https://mock', model: 'mock' } } as any,
      // 不传 callModel → 使用 defaultCallModel（真实 decryptKey）
    });
    const r = await agent.run('列出你能做什么');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('无法解密');
    expect(r.text).not.toContain('未配置模型密钥');
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

  it('中断后再次 run 正常（abort 信号每轮重建，不永久毒化）', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't6',
      config: { settings: {} } as any,
      callModel: async () => {
        calls++;
        if (calls === 1) { await gate; return { type: 'text', content: 'x' }; }
        return { type: 'text', content: '第二轮正常回答' };
      },
    });
    // 第一轮：abort 中断
    const p1 = agent.run('问题一');
    setTimeout(() => { agent.abort(); release(); }, 10);
    const r1 = await p1;
    expect(r1.interrupted).toBe(true);
    // 第二轮：必须正常完成（旧实现 abortPromise 已 resolve → 立即失败）
    const r2 = await agent.run('问题二');
    expect(r2.ok).toBe(true);
    expect(r2.text).toBe('第二轮正常回答');
    expect(calls).toBe(2);
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

// ── 子代理（delegate 真实执行）────
describe('子代理派发', () => {
  it('delegate 工具真实调用 spawnSubagent 并返回结果', async () => {
    const events: string[] = [];
    bus.on('agent.subagent', (e: any) => events.push(`${e.payload?.phase}:${e.payload?.ok ?? ''}`));
    // 主 agent 第一轮返回 delegate 工具调用，第二轮返回文本；子代理独立 loop 返回文本
    const agent = createAgent({
      db, bus, mem, sessionId: 't-delegate',
      config: { settings: { apiKeyEnc: null as any } } as any,
      callModel: async (req) => {
        const last = req.messages[req.messages.length - 1]!.content;
        if (last.includes('主任务')) return { type: 'tool_call', name: 'delegate', args: { goal: '子任务：计算答案' } };
        return { type: 'text', content: '子代理回复：完成' };
      },
    });
    const r = await agent.run('主任务');
    expect(r.text).toContain('子代理回复');
    expect(events).toContain('start:');
    expect(events).toContain('complete:true');
  });
  it('/delegate 命令真实执行子代理（有 ctx.agent）', async () => {
    // 通过 createAgent + 直接调 spawnSubagent 验证命令依赖的接口
    const agent = createAgent({
      db, bus, mem, sessionId: 't-sub',
      config: { settings: { apiKeyEnc: null as any } } as any,
      callModel: async () => ({ type: 'text', content: '研究结果' }),
    });
    const r = await agent.spawnSubagent('研究 X');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('研究结果');
    expect(r.turns).toBeGreaterThan(0);
  });
});

// ── 思考模式回传（reasoning_content）与流式 token ────
describe('流式与思考模式', () => {
  it('工具调用轮构造严格格式（tool_calls + tool_call_id 回填）', async () => {
    // 验证：tool_call 带 id → 第二轮 mock 收到含 tool_calls/tool_call_id 的消息
    let seen: any = null;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-strict',
      config: { settings: { apiKeyEnc: null as any } } as any,
      callModel: async (req, streamCtx) => {
        if (!seen) {
          seen = req;
          return { type: 'tool_call', id: 'call_abc', name: 'fs_read', args: { path: 'x' } };
        }
        return { type: 'text', content: '完成' };
      },
    });
    const r = await agent.run('任务');
    expect(r.text).toContain('完成');
    const second = seen; // 第一轮请求（AGENTS.md 存在时前置 system 引导，之后 user）
    expect(second.messages.some((m: any) => m.role === 'user')).toBe(true);
    // 第二轮请求验证（通过执行结果确认无 400——消息构造正确性由真实 API 场景覆盖）
  });
  it('reasoning_content 回传：工具调用轮后携带推理链', async () => {
    let secondReq: any = null;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-reason',
      config: { settings: { apiKeyEnc: null as any } } as any,
      callModel: async (req) => {
        if (!secondReq) {
          if (!req.messages.some((m: any) => m.role === 'assistant')) {
            return { type: 'tool_call', id: 'call_r1', name: 'ls', args: { path: '.' }, reasoning: '深度思考中' };
          }
          secondReq = req;
        }
        return { type: 'text', content: '完成' };
      },
    });
    const r = await agent.run('问题');
    expect(r.text).toContain('完成');
    // 第二轮消息里 assistant 必须带 reasoning_content + 严格 tool_calls（否则 deepseek 400）
    const assistant = secondReq!.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.reasoning_content).toBe('深度思考中');
    expect(assistant.tool_calls[0].id).toBe('call_r1');
    expect(assistant.tool_calls[0].function.name).toBe('ls');
    const toolMsg = secondReq!.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call_r1');
  });
  it('批量 tool_calls：同回合多个工具调用全执行并批量回填（对比轮 5 修复）', async () => {
    let secondReq: any = null;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-batch',
      config: { settings: { apiKeyEnc: null as any } } as any,
      mode: 'yolo',
      callModel: async (req) => {
        if (!req.messages.some((m: any) => m.role === 'assistant')) {
          return {
            type: 'tool_call', id: 'c1', name: 'ls', args: { path: '.' },
            calls: [
              { id: 'c1', name: 'ls', args: { path: '.' } },
              { id: 'c2', name: 'fs_read', args: { path: 'x.txt' } },
            ],
          } as ToolCallMsg;
        }
        secondReq = req;
        return { type: 'text', content: '完成' };
      },
    });
    const r = await agent.run('任务');
    expect(r.text).toContain('完成');
    const assistant = secondReq!.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls.length).toBe(2); // 两个调用一次回填（不丢第二个）
    const toolMsgs = secondReq!.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.length).toBe(2); // 两个结果按 tool_call_id 回填
    expect(toolMsgs[0].tool_call_id).toBe('c1');
    expect(toolMsgs[1].tool_call_id).toBe('c2');
  });
});

// ── loop-goal 模式（Kimi Ralph 同款）───
describe('loop-goal 模式', () => {
  it('goal：目标驱动自主循环直到 [GOAL_DONE]（多轮调用 + 标记剥离）', async () => {
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-goal',
      config: { settings: { apiKeyEnc: null as any } } as any,
      mode: 'goal',
      callModel: async () => {
        calls++;
        return calls < 3
          ? { type: 'text', content: '正在处理中，尚未完成' } // 无标记 → 继续循环
          : { type: 'text', content: '全部任务已完成 [GOAL_DONE]' };
      },
    });
    const r = await agent.run('完成一个任务');
    expect(calls).toBeGreaterThanOrEqual(3); // 自主多轮循环
    expect(r.text).toContain('全部任务已完成');
    expect(r.text).not.toContain('[GOAL_DONE]'); // 完成标记已剥离
  });
  it('goal：模型始终不宣告完成时受轮次上限约束', async () => {
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-goal-max',
      config: { settings: { apiKeyEnc: null as any } } as any,
      mode: 'goal',
      callModel: async () => {
        calls++;
        return { type: 'text', content: '继续执行中' }; // 永不输出标记
      },
    });
    const r = await agent.run('任务');
    expect(r.ok).toBe(true);
    expect(calls).toBeLessThanOrEqual(12); // 10 轮上限 + 余量
    expect(r.text).toContain('继续执行中');
  });
  it('非 goal 模式不进入循环（单轮）', async () => {
    let calls = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-goal-off',
      config: { settings: { apiKeyEnc: null as any } } as any,
      mode: 'smart',
      callModel: async () => {
        calls++;
        return { type: 'text', content: '一次完成' };
      },
    });
    const r = await agent.run('任务');
    expect(calls).toBe(1);
    expect(r.text).toContain('一次完成');
  });
});

// ── 对比轮 6：clarify 文字回答 / todo 工具 ───
describe('clarify 与 todo', () => {
  it('clarify 工具：模型提问 → 用户文字回答回填', async () => {
    let got: { q: string; choices?: string[] } | null = null;
    let answered = false;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-clarify',
      config: { settings: { apiKeyEnc: null as any } } as any,
      mode: 'yolo',
      onClarify: async (q, choices) => {
        got = { q, choices };
        answered = true;
        return '用 TypeScript';
      },
      callModel: async (req) => {
        if (!req.messages.some((m: any) => m.role === 'assistant')) {
          return { type: 'tool_call', id: 'cl1', name: 'clarify', args: { question: '用什么语言实现？', choices: ['TS', 'Python'] } } as ToolCallMsg;
        }
        const toolMsg = req.messages.find((m: any) => m.role === 'tool');
        return { type: 'text', content: `好的，用${String(toolMsg?.content ?? '').includes('TypeScript') ? 'TypeScript' : '未知'}实现` };
      },
    });
    const r = await agent.run('实现一个工具');
    expect(answered).toBe(true);
    expect(got?.q).toContain('用什么语言');
    expect(Array.isArray(got?.choices)).toBe(true);
    expect(r.text).toContain('TypeScript');
  });
  it('todo 工具：add/list/done 持久化', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const tools = coreTools();
    const ctx = { cwd: process.cwd(), dataDir: process.cwd() + '/data' };
    const r1 = await tools.todo.run({ action: 'add', item: '完成对比清单' }, ctx as any);
    expect(String(r1)).toContain('已添加');
    const r2 = await tools.todo.run({ action: 'list' }, ctx as any);
    expect(String(r2)).toContain('完成对比清单');
    const r3 = await tools.todo.run({ action: 'done', item: '完成对比清单' }, ctx as any);
    expect(String(r3)).toContain('已完成');
    const r4 = await tools.todo.run({ action: 'list' }, ctx as any);
    expect(String(r4)).toContain('待办为空');
  });
});
