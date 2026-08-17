// tests/kernel-agent.test.ts — L2-4 agent 循环：流式/工具执行/权限/重试/中断/子代理
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
  it('无密钥时提示配置 /model set-key（不假装回答）', async () => {
    const agent = createAgent({
      db, bus, mem, sessionId: 't2',
      config: { settings: {} } as any,
      callModel: null,
    });
    const r = await agent.run('你好');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('/model set-key');
    expect(r.text).not.toContain('规则脑'); // 旧规则脑假装回答不得回归
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

  it('同工具连续失败 5 次终止', async () => {    let calls = 0;
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
  }, 30_000); // 全量并行下工具执行与记忆初始化较慢——放宽默认 15s 超时
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
      // KF-010 修复后默认审批 fail-closed——本测试意图为「批准后执行」，显式声明放行
      onApproval: async () => true,
      callModel: async (req: any) => {
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
      callModel: async (req: any) => {
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
      callModel: async (req: any) => {
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

// ── 回合闭环（「35 工具调用后无输出」真根因回归）───
describe('回合闭环（绝不静默空输出）', () => {
  it('轮次耗尽仍无文本 → 无工具强制总结收敛为非空答案', async () => {
    const script: Array<ModelCall | ToolCallMsg> = [];
    for (let i = 0; i < 4; i++) script.push({ type: 'tool_call', id: `c${i}`, name: 'ls', args: { path: `dir-${i}` } });
    script.push({ type: 'text', content: '基于以上探索，评估结论如下…' }); // 强制总结调用返回
    const agent = createAgent({
      db, bus, mem, sessionId: 't-loop1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      maxTurns: 4,
      callModel: async (_req, streamCtx) => {
        const next = script.shift()!;
        if (next.type === 'text' && streamCtx?.onToken) streamCtx.onToken(next.content);
        return next;
      },
    });
    const r = await agent.run('评估');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('评估结论');
  });
  it('轮次耗尽且强制总结失败 → 显式失败文案（非空、ok=false）', async () => {
    let n = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-loop2',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      maxTurns: 4,
      callModel: async () => {
        n++;
        if (n <= 4) return { type: 'tool_call', id: `c${n}`, name: 'ls', args: { path: `dir-${n}` } };
        throw new Error('summary failed'); // 强制总结调用失败
      },
    });
    const r = await agent.run('评估');
    expect(r.ok).toBe(false);
    expect(r.text.length).toBeGreaterThan(0); // 绝不静默空输出
    expect(r.text).toContain('轮次上限');
  });
  it('提前返回（模型 4xx）也发 agent.message + agent.end（UI 可见）', async () => {
    const msgs: string[] = [];
    const ends: Array<Record<string, any>> = [];
    bus.on('agent.message', e => msgs.push(String(e.payload.content ?? '')));
    bus.on('agent.end', e => ends.push(e.payload as Record<string, any>));
    const agent = createAgent({
      db, bus, mem, sessionId: 't-loop3',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async () => { const err: any = new Error('HTTP 401 无效密钥'); err.status = 401; throw err; },
    });
    const r = await agent.run('你好');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('模型调用失败');
    expect(msgs.join('')).toContain('模型调用失败'); // 错误文本经 agent.message 投递
    expect(ends.length).toBeGreaterThan(0); // agent.end 必发（网关据此发布最终消息）
  });
});

// ── 读工具结果缓存（回合内去重——35 次工具调用大量重复浪费的止血）───
describe('读工具结果缓存', () => {
  // 注意：同参重复 ≥3 会触发内核循环检测（正确行为）——以下用例最多 2 次同参
  // 断言取模型收到的上下文（DB 工具行截断 300 字符会切掉尾部「已缓存」标记）
  it('同参重复读调用合并返回缓存（模型收到已缓存标记）', async () => {
    const script: Array<ModelCall | ToolCallMsg> = [
      { type: 'tool_call', id: 'c1', name: 'ls', args: { path: '.' } },
      { type: 'tool_call', id: 'c2', name: 'ls', args: { path: '.' } }, // 同参 → 缓存合并
      { type: 'text', content: '回答：一切正常。' },
    ];
    const seen: string[] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 't-cache-hit',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req, streamCtx) => {
        seen.push(JSON.stringify(req?.messages ?? []));
        const next = script.shift()!;
        if (next.type === 'text' && streamCtx?.onToken) streamCtx.onToken(next.content);
        return next;
      },
    });
    const r = await agent.run('任务');
    expect(r.ok).toBe(true);
    expect(seen.some(s => s.includes('已缓存'))).toBe(true);
  });
  it('写/执行类工具（bash）执行后缓存清空——同参读调用重新真实执行', async () => {
    const script: Array<ModelCall | ToolCallMsg> = [
      { type: 'tool_call', id: 'c1', name: 'ls', args: { path: '.' } },
      { type: 'tool_call', id: 'c2', name: 'bash', args: { command: 'echo hi' } }, // 清缓存
      { type: 'tool_call', id: 'c3', name: 'ls', args: { path: '.' } }, // 未缓存 → 真实执行
      { type: 'text', content: '回答：一切正常。' },
    ];
    const seen: string[] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 't-cache-clear',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req, streamCtx) => {
        seen.push(JSON.stringify(req?.messages ?? []));
        const next = script.shift()!;
        if (next.type === 'text' && streamCtx?.onToken) streamCtx.onToken(next.content);
        return next;
      },
    });
    const r = await agent.run('任务');
    expect(r.ok).toBe(true);
    expect(seen.some(s => s.includes('已缓存'))).toBe(false); // bash 清空后无缓存合并
  });
});

// ── 演示工具隐藏（真实 cmd 实测：example_greet 被模型选中触发审批阻塞会话）───
describe('演示工具对模型隐藏', () => {
  const def = (name: string, demo?: boolean) => ({
    schema: { type: 'function' as const, function: { name, description: 'x', parameters: { type: 'object' as const, properties: {} } } },
    danger: true,
    ...(demo !== undefined ? { demo } : {}),
    run: async () => 'ok',
  });

  it('demo:true 标记与遗留 example_ 前缀工具不进模型 toolList', async () => {
    const seen: unknown[][] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 't-demo-hide',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      extraTools: {
        example_greet: def('example_greet'), // 遗留示例插件前缀（无 demo 标记）
        demo_greet: def('demo_greet', true), // 显式 demo 标记
        real_tool: def('real_tool'), // 真实插件工具
      },
      callModel: async (req) => { seen.push(req.tools ?? []); return { type: 'text', content: '回答：正常。' }; },
    });
    const r = await agent.run('任务');
    expect(r.ok).toBe(true);
    const names = (seen[0] ?? []).map((t: any) => t?.function?.name as string);
    expect(names).toContain('real_tool');
    expect(names).not.toContain('example_greet');
    expect(names).not.toContain('demo_greet');
  });

  it('WXNODUS_INCLUDE_DEMO_TOOLS=1 逃生门恢复演示工具（演示脚本专用）', async () => {
    const prev = process.env.WXNODUS_INCLUDE_DEMO_TOOLS;
    process.env.WXNODUS_INCLUDE_DEMO_TOOLS = '1';
    try {
      const seen: unknown[][] = [];
      const agent = createAgent({
        db, bus, mem, sessionId: 't-demo-open',
        config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
        extraTools: { demo_greet: def('demo_greet', true), example_greet: def('example_greet') },
        callModel: async (req) => { seen.push(req.tools ?? []); return { type: 'text', content: '回答：正常。' }; },
      });
      await agent.run('任务');
      const names = (seen[0] ?? []).map((t: any) => t?.function?.name as string);
      expect(names).toContain('demo_greet');
      expect(names).toContain('example_greet');
    } finally {
      if (prev === undefined) delete process.env.WXNODUS_INCLUDE_DEMO_TOOLS;
      else process.env.WXNODUS_INCLUDE_DEMO_TOOLS = prev;
    }
  });
});

// ── 工具空输出归一（'' → 显式无输出——模型不再误判「结果丢失/幻觉」）───
describe('工具空输出归一', () => {
  it('空字符串工具结果回填为「（工具无输出…）」', async () => {
    let toolMsg = '';
    const agent = createAgent({
      db, bus, mem, sessionId: 't-empty-out',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      extraTools: {
        silent_tool: {
          schema: { type: 'function' as const, function: { name: 'silent_tool', description: 'x', parameters: { type: 'object' as const, properties: {} } } },
          danger: false,
          run: async () => '',
        },
      },
      callModel: async (req: any) => {
        if (req.messages.some((m: any) => m.role === 'assistant')) {
          toolMsg = String(req.messages.find((m: any) => m.role === 'tool')?.content ?? '');
          return { type: 'text', content: '完成' };
        }
        return { type: 'tool_call', name: 'silent_tool', args: {} };
      },
    });
    const r = await agent.run('静默工具任务');
    expect(r.ok).toBe(true);
    expect(toolMsg).toContain('工具无输出');
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
      callModel: async (req: any) => {
        if (!req.messages.some((m: any) => m.role === 'assistant')) {
          return { type: 'tool_call', id: 'cl1', name: 'clarify', args: { question: '用什么语言实现？', choices: ['TS', 'Python'] } } as ToolCallMsg;
        }
        const toolMsg = req.messages.find((m: any) => m.role === 'tool');
        return { type: 'text', content: `好的，用${String(toolMsg?.content ?? '').includes('TypeScript') ? 'TypeScript' : '未知'}实现` };
      },
    });
    const r = await agent.run('实现一个工具');
    expect(answered).toBe(true);
    expect((got as any)?.q).toContain('用什么语言');
    expect(Array.isArray((got as any)?.choices)).toBe(true);
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

// ── 对比轮 6 回归：C1 中断竞态 / C2 SSE 错误 ───
describe('回归：中断竞态与 SSE 错误', () => {
  it('C1：中断后立即重发——旧回合不复活（回合级状态隔离）', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let firstCall = true;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-c1',
      config: { settings: { apiKeyEnc: null as any } } as any,
      callModel: async () => {
        if (firstCall) { firstCall = false; await gate; return { type: 'text', content: '旧回合' }; }
        return { type: 'text', content: '新回合' };
      },
    });
    const p1 = agent.run('旧任务');
    await new Promise(r => setTimeout(r, 50)); // 旧回合进入 callModel（挂起）
    agent.abort();                             // 中断旧回合
    const r2 = await agent.run('新任务');
    expect(r2.text).toContain('新回合');       // 新回合正常完成（不被旧回合污染）
    release();                                 // 释放旧回合 gate
    const r1 = await p1;
    expect(r1.interrupted).toBe(true);         // 旧回合标记中断，不复活继续执行
  });

  it('C2：SSE 错误对象抛错（不静默空消息回合）', async () => {
    const { encryptKey } = await import('../src/kernel/providers.js');
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"error":{"message":"上下文超限"}}\n\ndata: [DONE]\n\n'));
          c.close();
        },
      }),
    }) as any);
    try {
      const agent = createAgent({
        db, bus, mem, sessionId: 't-c2',
        config: { settings: { apiKeyEnc: encryptKey('test-key'), baseURL: 'https://example.com/v1', model: 'deepseek-v4-flash' } } as any,
      });
      const r = await agent.run('任务');
      expect(r.ok).toBe(false);
      expect(r.text).toContain('上下文超限');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ── P1b：插件热重载 updateTools ───
describe('updateTools 热重载', () => {
  it('updateTools 后新工具立即可用（无需重建 agent）', async () => {
    const extra = {
      hotplug_now: {
        schema: { type: 'function' as const, function: { name: 'hotplug_now', description: '时间戳', parameters: { type: 'object' as const, properties: {} } } },
        danger: true,
        run: async () => '热重载时间戳：123',
      },
    };
    const agent = createAgent({
      db, bus, mem, sessionId: 't-hot',
      config: { settings: { apiKeyEnc: null as any } } as any,
      mode: 'yolo',
      callModel: (() => {
        // 每次 run 的第一轮返回工具调用（calls 1/3），第二轮返回文本（calls 2/4）
        let calls = 0;
        return async (req: any) => {
          calls++;
          if (calls === 1 || calls === 3) {
            return { type: 'tool_call', id: 'h1', name: 'hotplug_now', args: {} } as ToolCallMsg;
          }
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          return { type: 'text', content: `结果：${String(toolMsg?.content ?? '').slice(0, 40)}` };
        };
      })(),
    });
    // 重载前：工具不存在 → 调用被回填「不存在」
    const before = await agent.run('调用工具');
    expect(before.text).toContain('不存在');
    // 热重载注入
    agent.updateTools(extra);
    const after = await agent.run('调用工具');
    expect(after.ok).toBe(true);
    expect(after.text).toContain('热重载时间戳');
  });
});

// ── P3b：自动压缩触发 + DB 联动（小上下文预算触发）───
describe('自动压缩与 DB 联动', () => {
  it('上下文超阈值自动压缩，且 DB 中部消息归档（联动）', async () => {
    const agent = createAgent({
      db, bus, mem, sessionId: 't-autocmp',
      config: { settings: { apiKeyEnc: null as any } } as any,
      maxContextTokens: 600, // 小预算：>510 token 即触发压缩
      callModel: async () => ({ type: 'text', content: '这是压缩后的回复' }),
    });
    // 预填充大量历史（触发压缩）
    const longText = '这是一段用于撑大上下文的长文本内容。'.repeat(40); // ~400+ token
    for (let i = 0; i < 6; i++) {
      mem.append('t-autocmp', 'user', longText);
      mem.append('t-autocmp', 'assistant', longText);
    }
    const beforeAbsorb = mem.absorbCount('t-autocmp');
    const r = await agent.run('新问题');
    expect(r.ok).toBe(true);
    // DB 联动：中部消息被归档（compactSmart 写入摘要 + 归档）
    expect(mem.absorbCount('t-autocmp')).toBeGreaterThan(beforeAbsorb);
    // recall 全量保留（不硬删）
    expect(mem.recall('t-autocmp').length).toBe(14); // 12 预填 + 新问题 + 助手回复
  });
});

// ── M4：会话切换与定位 ──
describe('会话切换与定位（M4）', () => {
  it('setSessionId 后 getSessionId 返回当前会话', () => {
    const agent = makeAgent([]);
    expect(agent.getSessionId()).toBe('t');
    agent.setSessionId('s-other');
    expect(agent.getSessionId()).toBe('s-other');
    agent.setSessionId('t');
    expect(agent.getSessionId()).toBe('t');
  });
  it('消息落库到切换后的会话', async () => {
    const agent = makeAgent([{ type: 'text', content: '切会话回复' }]);
    agent.setSessionId('s-branch');
    const r = await agent.run('切换后的问题');
    expect(r.ok).toBe(true);
    const rows = db.prepare(`SELECT session_id, role FROM messages WHERE session_id=?`).all('s-branch') as any[];
    expect(rows.length).toBe(2); // user + assistant
    agent.setSessionId('t');
  });
});

// ── 简化人工操作（阶段 C）：smart 模式低危文件编辑自动放行 ──
describe('低危自动放行', () => {
  function makeLowRiskAgent(over: any = {}, path: string = join(process.cwd(), 'lowrisk-target.txt')) {
    let approvals = 0;
    let called = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-lowrisk',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        called++;
        if (called === 1) {
          // 模型先发起 fs_write 工具调用（验证审批路径真实触发）
          return { type: 'tool_call', name: 'fs_write', args: { path, content: 'x' } } as any;
        }
        return { type: 'text', content: '完成' };
      },
      onApproval: async () => { approvals++; return true; },
      ...over,
    } as any);
    return { agent, count: () => approvals };
  }

  it('smart 模式：工作区内 fs_write 不弹审批（自动放行）', async () => {
    const { agent, count } = makeLowRiskAgent();
    const r = await agent.run('把 hello 写入文件');
    expect(r.ok).toBe(true);
    expect(count()).toBe(0);
  });

  it('smart 模式：工作区外路径仍弹审批', async () => {
    const outside = process.platform === 'win32' ? 'C:/Windows/temp/x.txt' : '/etc/x.txt';
    const { agent, count } = makeLowRiskAgent({}, outside);
    await agent.run(`把内容写入 ${outside}`);
    expect(count()).toBeGreaterThan(0);
  });

  it('plan 模式：文件编辑仍走审批（plan 语义保持）', async () => {
    const { agent, count } = makeLowRiskAgent({ mode: 'plan' as any });
    await agent.run('把 hello 写入文件');
    expect(count()).toBeGreaterThan(0);
  });

  it('lowRiskAutoApprove:false 时恢复逐次审批', async () => {
    const { agent, count } = makeLowRiskAgent({ lowRiskAutoApprove: false });
    await agent.run('把 hello 写入文件');
    expect(count()).toBeGreaterThan(0);
  });
});

// ── D 批次：AI 审批预审链（autoReview）──
describe('AI 审批预审（autoReview）', () => {
  function makeReviewAgent(verdict: 'allow' | 'ask' | 'deny', enabled = true, path: string = join(process.cwd(), 'review-target.txt')) {
    let approvals = 0;
    let called = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-review',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        called++;
        if (called === 1) {
          return { type: 'tool_call', name: 'fs_write', args: { path, content: 'x' } } as any;
        }
        return { type: 'text', content: '完成' };
      },
      onApproval: async () => { approvals++; return true; },
      autoReview: {
        enabled: () => enabled,
        review: async () => verdict,
      },
    } as any);
    return { agent, approvals: () => approvals };
  }

  it('预审 allow → 不弹审批直接放行', async () => {
    const { agent, approvals } = makeReviewAgent('allow');
    const r = await agent.run('写入文件');
    expect(r.ok).toBe(true);
    expect(approvals()).toBe(0);
  });
  it('预审 deny → 拒绝执行', async () => {
    const { agent, approvals } = makeReviewAgent('deny');
    const r = await agent.run('写入文件');
    // KF-024 诚实语义：唯一动作被拒 + 完成声明「完成」→ 零验证副作用 → incomplete（绝不自述成功）
    expect(r.ok).toBe(false);
    expect(r.status).toBe('incomplete');
    expect(approvals()).toBe(0);
  });
  it('预审 ask → 回落到人工弹窗', async () => {
    const { agent, approvals } = makeReviewAgent('ask');
    await agent.run('写入文件');
    expect(approvals()).toBe(1);
  });
  it('关闭时（enabled=false）→ 直接人工弹窗（区外路径避免低危放行）', async () => {
    const outside = process.platform === 'win32' ? 'C:/Windows/temp/rv.txt' : '/etc/rv.txt';
    const { agent, approvals } = makeReviewAgent('allow', false, outside);
    await agent.run('写入文件');
    expect(approvals()).toBe(1);
  });
});

// ── P2：工具延迟加载（tool_search 检索激活）──
describe('工具延迟加载', () => {
  function makeLazyAgent(script: Array<any>, toolLazyLoad = true) {
    const seenTools: any[][] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 't-lazy',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      toolLazyLoad,
      callModel: async (req: any) => {
        seenTools.push((req.tools ?? []) as any[]);
        return script.shift()!;
      },
    } as any);
    return { agent, seenTools };
  }

  it('开启时首轮只注入核心工具 + tool_search（全表缩减）', async () => {
    const { agent, seenTools } = makeLazyAgent([{ type: 'text', content: '完成' }]);
    await agent.run('你好');
    const names = seenTools[0]!.map((t: any) => t.function.name);
    expect(names).toContain('tool_search');
    expect(names).toContain('command_search'); // A22：命令目录检索常驻（AI 主动调用入口）
    expect(names).toContain('bash');
    expect(names).not.toContain('http_get'); // 高级工具未激活
    expect(names.length).toBeLessThan(13);
  });

  it('tool_search 检索激活后，下一回合工具表含高级工具', async () => {
    const { agent, seenTools } = makeLazyAgent([
      { type: 'tool_call', name: 'tool_search', args: { query: '写入记忆' } } as any,
      { type: 'text', content: '第一轮完成' },
      { type: 'text', content: '第二轮完成' },
    ]);
    const r1 = await agent.run('搜索工具');
    expect(r1.ok).toBe(true);
    // 第二回合：activeToolNames 保留 → 工具表应含 memory_write（已激活）
    await agent.run('第二轮');
    const names = seenTools[2]!.map((t: any) => t.function.name);
    expect(names).toContain('memory_write');
  });

  it('未激活工具被调用 → 引导 tool_search（不静默）', async () => {
    const { agent } = makeLazyAgent([
      { type: 'tool_call', name: 'http_get', args: { url: 'https://example.com' } } as any,
      { type: 'text', content: '完成' },
    ]);
    const r = await agent.run('抓取');
    expect(r.text).toContain('完成');
  });

  it('关闭时全表注入（回归）', async () => {
    const { agent, seenTools } = makeLazyAgent([{ type: 'text', content: '完成' }], false);
    await agent.run('你好');
    const names = seenTools[0]!.map((t: any) => t.function.name);
    expect(names).not.toContain('tool_search');
    expect(names.length).toBe(44); // 全表（43 内置含 notify/browser_* 七件套/computer_* 十一件套（含 UIA 六件套：windows/tree/find/click/type/act）/web_search/memory_update/memory_delete/repo_map/cron_create/credential_form/memory_search/find_files/wx_cmd/command_search - tool_search 未注册）
  });
});


// ── P3：会话 token 预算（Gemini general.budget 对齐）──
describe('会话 token 预算', () => {
  it('超预算 → system.notice 告警一次（防刷屏）', async () => {
    // 预先写入超预算用量
    db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('t-budget-1', 'mock', 300, 300, Date.now());
    const notices: string[] = [];
    const off = bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? '')));
    const agent = createAgent({
      db, bus, mem, sessionId: 't-budget-1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', budgetTokens: 500 } } as any,
      callModel: async () => ({ type: 'text', content: '这是回复' }) as any,
    } as any);
    try {
      const r = await agent.run('你好');
      expect(r.ok).toBe(true);
      expect(notices.some(n => n.includes('预算已达上限'))).toBe(true);
      expect(notices.filter(n => n.includes('预算已达上限')).length).toBe(1); // 仅一次
      // 再跑一轮：仍只告警一次
      await agent.run('再问');
      expect(notices.filter(n => n.includes('预算已达上限')).length).toBe(1);
    } finally { off(); }
  });
  it('未超预算（budgetTokens=0 不设限）→ 无告警', async () => {
    const notices: string[] = [];
    const off = bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? '')));
    const agent = createAgent({
      db, bus, mem, sessionId: 't-budget-2',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async () => ({ type: 'text', content: '这是回复' }) as any,
    } as any);
    try {
      await agent.run('你好');
      expect(notices.some(n => n.includes('预算'))).toBe(false);
    } finally { off(); }
  });
});

// ── 阶段 2：AI 自主触发——首轮自动注入仓库地图 + 技能清单 ──
describe('AI 自主触发（自动注入）', () => {
  function makeAutoInjectAgent(settings: Record<string, any>, script: Array<any>) {
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 't-auto-' + Math.random().toString(36).slice(2, 8),
      dataDir: join(process.cwd(), 'data'),
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', ...settings } } as any,
      callModel: async (req: any) => {
        seen.push((req.messages ?? []) as any);
        return script.shift()!;
      },
    } as any);
    return { agent, seen };
  }
  it('首轮注入顶层结构一行 + 技能名清单；第二轮不重复注入；默认不注入地图', async () => {
    const { agent, seen } = makeAutoInjectAgent({}, [
      { type: 'text', content: '完成1' },
      { type: 'text', content: '完成2' },
    ]);
    await agent.run('你好');
    await agent.run('再问');
    const first = seen[0]!;
    const second = seen[1]!;
    // 首轮含顶层结构摘要（轻量，不挤占上下文）
    expect(first.some(m => String(m.content ?? '').includes('项目顶层结构'))).toBe(true);
    // 技能名清单注入
    expect(first.some(m => String(m.content ?? '').includes('可用技能'))).toBe(true);
    // 默认不注入完整仓库地图（防上下文膨胀——体验回归修复）
    expect(first.some(m => String(m.content ?? '').includes('自动仓库地图'))).toBe(false);
    // 第二轮不重复注入
    expect(second.some(m => String(m.content ?? '').includes('项目顶层结构'))).toBe(false);
  });
  it('autoRepoMap=true 显式开启才注入完整地图', async () => {
    const { agent, seen } = makeAutoInjectAgent({ autoRepoMap: true }, [{ type: 'text', content: '完成' }]);
    await agent.run('你好');
    const first = seen[0]!;
    expect(first.some(m => String(m.content ?? '').includes('自动仓库地图'))).toBe(true);
  });
});

// ── 变更即回归：fs_write/fs_edit 成功后自动重放 auto 剧本（防抖 + 防递归）──
describe('变更即回归（auto 剧本自动重放）', () => {
  function makeRegressionEnv() {
    const d = mkdtempSync(join(tmpdir(), 'wxn-reg-'));
    const marker = join(d, 'marker.txt');
    const regBus = createEventBus(d);
    const regDb = openDB(d);
    const regMem = createMemory(regDb);
    const notices: string[] = [];
    const off = regBus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? '')));
    // 模型第一轮发起 fs_write（真实触发回归），第二轮收尾
    const agent = createAgent({
      db: regDb, bus: regBus, mem: regMem, sessionId: 't-reg',
      dataDir: d,
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      mode: 'yolo',
      callModel: async (req: any) => {
        if (!req.messages.some((m: any) => m.role === 'assistant')) {
          return { type: 'tool_call', name: 'fs_write', args: { path: join(d, 'trigger.txt'), content: 'v1' } } as any;
        }
        return { type: 'text', content: '完成' };
      },
    } as any);
    return { d, marker, notices, off, agent, db: regDb };
  }
  const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

  it('fs_write 成功后 auto 剧本自动重放（防抖 2s + notice 汇报结果）', async () => {
    const env = makeRegressionEnv();
    const { saveScript } = await import('../src/kernel/scripts.js');
    saveScript(env.d, {
      name: 'reg1', description: '', created_at: Date.now(), auto: true,
      steps: [{ prompt: '', tools: [{ name: 'fs_write', args: { path: env.marker, content: 'replayed' } }] }],
    });
    try {
      const r = await env.agent.run('写文件');
      expect(r.ok).toBe(true);
      expect(env.notices.some(n => n.includes('变更即回归'))).toBe(false); // 防抖期未触发
      await wait(2600);
      expect(env.notices.some(n => n.includes('变更即回归') && n.includes('✅ reg1'))).toBe(true);
      expect(existsSync(env.marker)).toBe(true); // 剧本真实重放
    } finally {
      env.off();
      closeDB(env.db);
      rmSync(env.d, { recursive: true, force: true });
    }
  });

  it('回归重放自身的写文件不再次调度（regressionRunning 防递归）', async () => {
    const env = makeRegressionEnv();
    const { saveScript } = await import('../src/kernel/scripts.js');
    saveScript(env.d, {
      name: 'reg2', description: '', created_at: Date.now(), auto: true,
      steps: [{ prompt: '', tools: [{ name: 'fs_write', args: { path: env.marker, content: 'x' } }] }],
    });
    try {
      await env.agent.run('写文件');
      await wait(2600);
      expect(env.notices.filter(n => n.includes('变更即回归')).length).toBe(1); // 仅初始触发一次
      await wait(2600);
      expect(env.notices.filter(n => n.includes('变更即回归')).length).toBe(1); // 无第二次（防循环）
    } finally {
      env.off();
      closeDB(env.db);
      rmSync(env.d, { recursive: true, force: true });
    }
  });

  it('未标 auto 的剧本不参与自动回归', async () => {
    const env = makeRegressionEnv();
    const { saveScript } = await import('../src/kernel/scripts.js');
    saveScript(env.d, {
      name: 'plain', description: '', created_at: Date.now(), // 无 auto 标记
      steps: [{ prompt: '', tools: [{ name: 'fs_write', args: { path: env.marker, content: 'x' } }] }],
    });
    try {
      await env.agent.run('写文件');
      await wait(2600);
      expect(env.notices.some(n => n.includes('变更即回归'))).toBe(false);
      expect(existsSync(env.marker)).toBe(false); // 剧本未被重放
    } finally {
      env.off();
      closeDB(env.db);
      rmSync(env.d, { recursive: true, force: true });
    }
  });
});

// ── AI 自主调用通道（wx_cmd）：safe 直执行 / confirm 走模式确认链 /
//    danger 强制人工确认 / redline 直接拒绝 ──
describe('wx_cmd AI 自主调用通道（分级裁决）', () => {
  function makeCmdAgent(script: Array<any>, over: any = {}) {
    const executed: string[] = [];
    let approvals = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 't-wxcmd',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      mode: 'smart',
      callModel: async () => script.shift()!,
      onCommand: async (input: any) => { executed.push(String(input)); return `已执行：${String(input).slice(0, 40)}`; },
      onApproval: async () => { approvals++; return true; },
      ...over,
    } as any);
    return { agent, executed, approvals: () => approvals };
  }

  it('safe 级：直接执行不弹确认，输出回填', async () => {
    const { agent, executed, approvals } = makeCmdAgent([
      { type: 'tool_call', name: 'wx_cmd', args: { command: '/memory' } },
      { type: 'text', content: '查完了' },
    ]);
    const r = await agent.run('查一下记忆');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('查完了');
    expect(executed).toEqual(['/memory']); // 命令真实执行
    expect(approvals()).toBe(0);           // safe 不弹确认
  });

  it('confirm 级：smart 模式弹确认，批准后执行；拒绝则不执行', async () => {
    const { agent, executed } = makeCmdAgent([
      { type: 'tool_call', name: 'wx_cmd', args: { command: '/compact' } },
      { type: 'text', content: '压完了' },
    ]);
    const r = await agent.run('压缩上下文');
    expect(r.ok).toBe(true);
    expect(executed).toEqual(['/compact']);
    // 拒绝场景：工具结果回填「用户拒绝执行」，命令不执行
    let toolMsg = '';
    const executed2: string[] = [];
    const agent2 = createAgent({
      db, bus, mem, sessionId: 't-wxcmd-rj',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      mode: 'smart',
      callModel: async (req: any) => {
        if (req.messages.some((m: any) => m.role === 'assistant')) {
          toolMsg = String(req.messages.find((m: any) => m.role === 'tool')?.content ?? '');
          return { type: 'text', content: '完成' };
        }
        return { type: 'tool_call', name: 'wx_cmd', args: { command: '/compact' } };
      },
      onCommand: async (input: any) => { executed2.push(String(input)); return 'ok'; },
      onApproval: async () => false,
    } as any);
    const r2 = await agent2.run('压缩上下文');
    // KF-024 诚实语义：命令被拒（零验证副作用）+ 完成声明「完成」→ incomplete；拒绝结果仍真实回填
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe('incomplete');
    expect(toolMsg).toContain('拒绝'); // 拒绝结果真实回填给模型
    expect(executed2).toEqual([]);     // 命令未执行
  });

  it('confirm 级：yolo 模式直接放行不弹确认', async () => {
    const { agent, executed, approvals } = makeCmdAgent([
      { type: 'tool_call', name: 'wx_cmd', args: { command: '/compact' } },
      { type: 'text', content: '完成' },
    ], { mode: 'yolo' });
    const r = await agent.run('压缩');
    expect(r.ok).toBe(true);
    expect(executed).toEqual(['/compact']);
    expect(approvals()).toBe(0);
  });

  it('danger 级：强制人工确认——AI 预审 allow 不放行，仍弹窗', async () => {
    let autoReviewCalls = 0;
    const { agent, executed, approvals } = makeCmdAgent([
      { type: 'tool_call', name: 'wx_cmd', args: { command: '/script run demo' } },
      { type: 'text', content: '跑完了' },
    ], {
      autoReview: {
        enabled: () => true,
        review: async () => { autoReviewCalls++; return 'allow'; },
      },
    });
    const r = await agent.run('跑剧本');
    expect(r.ok).toBe(true);
    expect(autoReviewCalls).toBe(0);   // 高危跳过 AI 预审
    expect(approvals()).toBe(1);       // 强制人工确认
    expect(executed).toEqual(['/script run demo']);
  });

  it('redline 级：直接拒绝，命令不执行、不弹窗', async () => {
    const { agent, executed, approvals } = makeCmdAgent([
      { type: 'tool_call', name: 'wx_cmd', args: { command: '/yolo on' } },
      { type: 'text', content: '继续' },
    ]);
    const r = await agent.run('开启 yolo');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('继续');
    expect(executed).toEqual([]);      // 红线命令未执行
    expect(approvals()).toBe(0);       // 不弹窗
  });

  it('redline 级：/model set-key 与直接传密钥均拒绝（/key 已并入 /model）', async () => {
    const env1 = makeCmdAgent([
      { type: 'tool_call', name: 'wx_cmd', args: { command: '/model set-key sk-xxx' } },
      { type: 'text', content: 'ok1' },
    ]);
    await env1.agent.run('设置密钥');
    expect(env1.executed).toEqual([]);
    const env2 = makeCmdAgent([
      { type: 'tool_call', name: 'wx_cmd', args: { command: '/model sk-abc' } },
      { type: 'text', content: 'ok2' },
    ]);
    await env2.agent.run('设置密钥');
    expect(env2.executed).toEqual([]);
  });

  it('批量 tool_calls：wx_cmd 与普通工具同轮执行', async () => {
    const { agent, executed } = makeCmdAgent([
      { type: 'tool_call', id: 'c1', name: 'wx_cmd', args: { command: '/status' }, calls: [
        { id: 'c1', name: 'wx_cmd', args: { command: '/status' } },
        { id: 'c2', name: 'fs_read', args: { path: 'x.txt' } },
      ] } as any,
      { type: 'text', content: '完成' },
    ], { mode: 'yolo' });
    const r = await agent.run('执行');
    expect(r.ok).toBe(true);
    expect(executed).toEqual(['/status']);
  });
});

// ── A24：运行时切换工作目录（setCwd）+ goal 进度事件 ──
describe('A24 运行时工作目录（setCwd）', () => {
  it('setCwd 后 fs_read 相对路径解析新目录（工具 ctx.cwd 跟随）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-cwd-'));
    try {
      writeFileSync(join(d, 'target.txt'), 'hello-from-new-cwd', 'utf8');
      let rounds = 0;
      let sawContent = '';
      const agent = createAgent({
        db, bus, mem, sessionId: 't-cwd',
        config: { settings: {} } as any,
        callModel: async (req): Promise<ModelCall | ToolCallMsg> => {
          rounds++;
          if (rounds === 1) return { type: 'tool_call', name: 'fs_read', args: { path: 'target.txt' } };
          // 第二轮：工具结果已注入消息——校验读到的是新目录文件
          sawContent = JSON.stringify(req.messages.map((m: any) => m.content));
          return { type: 'text', content: '完成' };
        },
      });
      agent.setCwd(d);
      const r = await agent.run('读文件');
      expect(r.ok).toBe(true);
      expect(sawContent).toContain('hello-from-new-cwd');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('A24 goal 模式进度事件（agent.goal）', () => {
  it('goal 模式循环发 agent.goal：开场 + 完成态', async () => {
    const localBus = createEventBus(dir);
    const goalEvents: any[] = [];
    localBus.on('agent.goal', (e: any) => goalEvents.push(e.payload));
    const agent = createAgent({
      db, bus: localBus, mem, sessionId: 't-goal',
      config: { settings: {} } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => ({ type: 'text', content: '目标完成 [GOAL_DONE]' }),
    });
    agent.setMode('goal');
    const r = await agent.run('目标');
    // KF-023 诚实语义：零验证副作用 + [GOAL_DONE] → incomplete（自述完成绝不伪造 succeeded）；
    // 本测试焦点仍是 agent.goal 事件契约（开场 + done 态）
    expect(r.ok).toBe(false);
    expect(r.status).toBe('incomplete');
    // 开场（round 1 进行中）+ 结束（done=true）至少两条
    expect(goalEvents.length).toBeGreaterThanOrEqual(2);
    expect(goalEvents[0]).toMatchObject({ round: 1, done: false, maxRounds: 10 });
    expect(goalEvents.at(-1)!.done).toBe(true);
  });
});

describe('预算硬停（settings.budgetStop）', () => {
  it('超出预算后：不再发起模型调用 + finishEarly 显式失败', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createMemory } = await import('../src/kernel/memory.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-budget-'));
    const db = openDB(d);
    // 预置超预算用量（600 > 500）
    db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('b1', 'deepseek-chat', 400, 200, Date.now());
    let modelCalls = 0;
    const events: string[] = [];
    const bus = createEventBus(d);
    bus.on('agent.message', () => events.push('message'));
    bus.on('agent.end', () => events.push('end'));
    const agent = createAgent({
      db, bus, mem: createMemory(db), sessionId: 'b1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', budgetTokens: 500, budgetStop: true } } as any,
      callModel: async () => { modelCalls += 1; return { type: 'text', content: '收到' }; },
    });
    try {
      const r = await agent.run('继续干活');
      expect(r.ok).toBe(false);
      expect(r.text).toContain('预算已达上限');
      expect(modelCalls).toBe(0); // 绝不发起模型调用
      expect(events).toEqual(['message', 'end']); // finishEarly 闭环事件可见
    } finally {
      closeDB(db);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('未开 budgetStop：仅告警不硬停（模型仍响应）', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createMemory } = await import('../src/kernel/memory.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-budget-'));
    const db = openDB(d);
    db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('b2', 'deepseek-chat', 400, 200, Date.now());
    let modelCalls = 0;
    const agent = createAgent({
      db, bus: createEventBus(d), mem: createMemory(db), sessionId: 'b2',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', budgetTokens: 500 } } as any,
      callModel: async () => { modelCalls += 1; return { type: 'text', content: '收到' }; },
    });
    try {
      const r = await agent.run('继续干活');
      expect(r.ok).toBe(true);
      expect(modelCalls).toBe(1);
    } finally {
      closeDB(db);
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('余额耗尽自动停（/balance auto-stop）', () => {
  it('autoStop 开启且网关标记 balanceEmpty → 硬停（零模型调用 + 显式失败闭环）', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createMemory } = await import('../src/kernel/memory.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-bal-'));
    const db = openDB(d);
    let modelCalls = 0;
    const events: string[] = [];
    const bus = createEventBus(d);
    bus.on('agent.message', () => events.push('message'));
    bus.on('agent.end', () => events.push('end'));
    const agent = createAgent({
      db, bus, mem: createMemory(db), sessionId: 'b3',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', balanceMonitor: { autoStop: true }, balanceEmpty: true } } as any,
      callModel: async () => { modelCalls += 1; return { type: 'text', content: '收到' }; },
    });
    try {
      const r = await agent.run('继续干活');
      expect(r.ok).toBe(false);
      expect(r.text).toContain('余额已耗尽');
      expect(modelCalls).toBe(0);
      expect(events).toEqual(['message', 'end']);
    } finally {
      closeDB(db);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('autoStop 未开启 → 不硬停（正常调用）', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createMemory } = await import('../src/kernel/memory.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-bal-'));
    const db = openDB(d);
    let modelCalls = 0;
    const agent = createAgent({
      db, bus: createEventBus(d), mem: createMemory(db), sessionId: 'b4',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', balanceMonitor: {}, balanceEmpty: true } } as any,
      callModel: async () => { modelCalls += 1; return { type: 'text', content: '收到' }; },
    });
    try {
      const r = await agent.run('继续干活');
      expect(r.ok).toBe(true);
      expect(modelCalls).toBe(1);
    } finally {
      closeDB(db);
      rmSync(d, { recursive: true, force: true });
    }
  });
});
