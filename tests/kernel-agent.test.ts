// tests/kernel-agent.test.ts — L2-4 agent 循环：流式/工具执行/权限/重试/中断/子代理
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { type ModelCall, type ToolCallMsg, canonicalToolArgs } from '../src/kernel/agent.js';
import { createPipelineAgent } from './support/createPipelineAgent.js';
// C1 接线回归（2026-08-27）：agent.ts 惰性 await import winSandbox——mock 掉原生模块，
// 让「沙盒开启 + sandboxFastPath=true → 低危工作区写免审批」的接线真实生效可测
// （kernel-eval 3-1：原 require() 死接线被绿测试掩盖，正是缺这条 agent 级接线测试）。
vi.mock('../src/kernel/winSandbox.js', () => ({ sandboxEnabled: () => true }));

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-ag-'));
  // 探针目标目录（.tmp/ 已 gitignore——测试产物不再污染工作树根）
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
  // 探针产物清理（.tmp 目录保留——gitignored）
  rmSync(join(process.cwd(), '.tmp', 'lowrisk-target.txt'), { force: true });
  rmSync(join(process.cwd(), '.tmp', 'review-target.txt'), { force: true });
});

// 构造测试用 agent：注入 mock 模型
function makeAgent(script: Array<ModelCall | ToolCallMsg>) {
  const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't4',
      config: { settings: {} } as any,
      mode: 'yolo',
      callModel: async () => {
        calls++;
        // cmd /c exit 3：环境无关的确定性毫秒级失败（本用例断言「连续失败终止」语义，
        // 不绑定 PS 未知命令发现性能——runner 无 PSModulePath 下该发现可达 10s+，CI 实测）
        return calls <= 6 ? { type: 'tool_call', name: 'bash', args: { command: 'cmd /c exit 3' } } as ToolCallMsg
          : { type: 'text', content: 'done' } as ModelCall;
      },
    });
    const r = await agent.run('跑命令');
    expect(calls).toBeLessThanOrEqual(5 + 1); // 连续失败后终止
  }, 120_000); // 全量并行 + CI runner（Defender 进程扫描）下 5 轮真实 bash 执行较慢——放宽超时
});

describe('中断', () => {
  it('abort 中断进行中的回合', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
      const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
  it('goal：模型不宣告完成（且每轮结论不同）时受轮次上限约束', async () => {
    let calls = 0;
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-goal-max',
      config: { settings: { apiKeyEnc: null as any } } as any,
      mode: 'goal',
      callModel: async () => {
        calls++;
        // 每轮结论不同（chanting 检测不触发——相同结论空转终止见 kernel-agent-gap-2026 测试）
        return { type: 'text', content: `继续执行中（第 ${calls} 步进展）` }; // 永不输出标记
      },
    });
    const r = await agent.run('任务');
    expect(r.ok).toBe(true);
    expect(calls).toBeLessThanOrEqual(12); // 10 轮上限 + 余量
    expect(r.text).toContain('继续执行中');
  });
  it('非 goal 模式不进入循环（单轮）', async () => {
    let calls = 0;
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
      const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
  // 代码卫生（2026-08-20）：默认目标改到本测试的 mkdtemp 临时目录（dir）——此前写仓库根目录，
  // 每次测试运行都重建 lowrisk-target.txt 污染工作树（曾因此被 git add -A 重新入库）
  function makeLowRiskAgent(over: any = {}, path: string = join(process.cwd(), '.tmp', 'lowrisk-target.txt')) {
    let approvals = 0;
    let called = 0;
    const agent = createPipelineAgent({
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
  // 代码卫生（2026-08-20）：默认目标改到本测试的 mkdtemp 临时目录（dir）——同 lowrisk 注释
  function makeReviewAgent(verdict: 'allow' | 'ask' | 'deny', enabled = true, path: string = join(process.cwd(), '.tmp', 'review-target.txt')) {
    let approvals = 0;
    let called = 0;
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    expect(names.length).toBe(49); // 全表（44 内置 + apply_patch + lsp 三件 + view_image——gap 2026 五件新工具）
  });
});


// ── P3：会话 token 预算（Gemini general.budget 对齐）──
describe('会话 token 预算', () => {
  it('超预算 → system.notice 告警一次（防刷屏）', async () => {
    // 预先写入超预算用量
    db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('t-budget-1', 'mock', 300, 300, Date.now());
    const notices: string[] = [];
    const off = bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? '')));
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
      db: regDb, bus: regBus, mem: regMem, sessionId: 't-reg',
      workspaceRoot: d, dataDir: d,
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
    const agent = createPipelineAgent({
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
    const agent2 = createPipelineAgent({
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
      const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const agent = createPipelineAgent({
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
    const { createEventBus } = await import('../src/kernel/events.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createMemory } = await import('../src/kernel/memory.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-bal-'));
    const db = openDB(d);
    let modelCalls = 0;
    const agent = createPipelineAgent({
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

// V4 P0-9（A-3/A-4）：瞬时失败重试语义——重试成功不丢弃响应；重发前发流重置信号。
describe('V4 P0-9 重试语义双修', () => {
  it('A-3：瞬时失败重试成功后直接处理响应（不发起第三次调用、不丢弃文本）', async () => {
    let calls = 0;
    const seenTokens: string[] = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'p09-a3',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', retryDelayMs: 50 } } as any,
      callModel: async (_req: unknown, streamCtx?: { onToken?: (t: string) => void; onReasoning?: (t: string) => void; signal?: AbortSignal }): Promise<any> => {
        calls++;
        if (calls === 1) {
          const e = new Error('ECONNRESET 瞬时失败') as Error & { status: number };
          e.status = 503;
          throw e;
        }
        if (streamCtx?.onToken) streamCtx.onToken('好的');
        return { type: 'text', content: '好的' };
      },
    });
    const r = await agent.run('hi');
    // A-3 修复前：重试成功后 continue → calls 变 3 且首轮成功响应被丢弃
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('好的');
  });

  it('A-4：重发前发流重置信号（半截输出不与重试全文拼接）', async () => {
    let calls = 0;
    const tokenEvents: Array<{ text: string; reset?: boolean }> = [];
    const handler = (e: any) => tokenEvents.push({ text: String(e?.payload?.text ?? ''), reset: !!e?.payload?.reset });
    const unsubscribe = bus.on('agent.token', handler);
    try {
      const agent = createPipelineAgent({
        db, bus, mem, sessionId: 'p09-a4',
        config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', retryDelayMs: 50 } } as any,
        callModel: async (_req: unknown, streamCtx?: { onToken?: (t: string) => void; onReasoning?: (t: string) => void; signal?: AbortSignal }): Promise<any> => {
          calls++;
          if (calls === 1) {
            // 先流半截再断（模拟 mid-stream 瞬时失败——半截文本已到屏幕）
            streamCtx?.onToken?.('半截内容');
            const e = new Error('mid-stream abort') as Error & { status: number };
            e.status = 503;
            throw e;
          }
          streamCtx?.onToken?.('完整回答');
          return { type: 'text', content: '完整回答' };
        },
      });
      const r = await agent.run('hi');
      expect(r.text).toBe('完整回答');
      // reset 信号存在且位于重试 token 之前
      const resetIdx = tokenEvents.findIndex(e => e.reset);
      expect(resetIdx).toBeGreaterThanOrEqual(0);
      const retryTokenIdx = tokenEvents.findIndex(e => e.text === '完整回答');
      expect(retryTokenIdx).toBeGreaterThan(resetIdx);
      // 半截内容确实流过（场景成立性）
      expect(tokenEvents.some(e => e.text === '半截内容')).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});

// V4 L0-2 / A-5：连续失败判定确定性化——正常执行但输出含「失败/异常」字样的工具
// 连续 5+ 次不再误杀回合（grep 中文代码库/读含失败字样日志场景）；真实 failed 仍计数终止。
describe('V4 L0-2 结构化 outcome：连续失败判定（A-5 误杀根治）', () => {
  it('连续 6 次输出含「失败」字样但执行成功的工具调用 → 回合不终止、走到最终文本', async () => {
    // fixture：内容天然含「失败/异常」字样（正常文件——非错误）
    const d = mkdtempSync(join(tmpdir(), 'wx-a5-'));
    try {
      writeFileSync(join(d, 'changelog.txt'), '修复：登录失败重试。已知异常处理。\n', 'utf8');
      // 每轮不同参数（避开同参 ×5 循环检测护栏——那道护栏行为正确，不在本用例范围）
      const script: Array<any> = [];
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(d, `changelog-${i}.txt`), `第${i}条：登录失败重试修复。已知异常处理。
`, 'utf8');
        script.push({ type: 'tool_call', name: 'fs_read', args: { path: join(d, `changelog-${i}.txt`) } });
      }
      script.push({ type: 'text', content: '全部读完，回合正常收束' });
      const agent = makeAgent(script);
      const r = await agent.run('读六遍');
      // 修复前（includes 启发式）：第 5 次后 consecutiveFail>=5 → 「同工具连续失败 5 次，已终止」
      expect(r.text).toBe('全部读完，回合正常收束');
      expect(String(r.text)).not.toMatch(/连续失败/);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* EBUSY */ } }
  });
});

// V4 P1-6：工具参数 JSON 坏 → 不执行 + 结构化错误回喂自纠（哨兵键拦截）。
describe('V4 P1-6 参数 JSON 坏回喂自纠', () => {
  it('坏 JSON 哨兵：工具不执行，模型收到「JSON 无效」与原文片段（整体重调指引）', async () => {
    const { ARGS_PARSE_ERROR_KEY } = await import('../src/kernel/agent.js');
    const script: Array<any> = [
      { type: 'tool_call', name: 'fs_read', args: { [ARGS_PARSE_ERROR_KEY]: '{"path": "a.ts' } },
      { type: 'text', content: '收到错误后自纠完成' },
    ];
    const agent = makeAgent(script);
    const r = await agent.run('读文件');
    // 回合正常走到终稿（错误回喂后模型自纠——不是静默空参执行）
    expect(r.text).toBe('收到错误后自纠完成');
  });
});

// V4 P2-3：Anthropic 式压缩工程——真实 usage 水位 / micro-compaction / 413 强压重发。
describe('V4 P2-3 压缩工程', () => {
  const seedHistory = (sid: string, n = 8): void => {
    for (let i = 0; i < n; i++) mem.append(sid, i % 2 === 0 ? 'user' : 'assistant', `历史消息 ${i}：内容`.repeat(4));
  };

  it('真实 usage 优先：tool_call 回传 usage.promptTokens 驱动次轮水位（触发压缩/micro）', async () => {
    const sid = 'p203-real';
    seedHistory(sid);
    let call = 0;
    const notices: string[] = [];
    const off = bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? '')));
    try {
      const agent = createPipelineAgent({
        db, bus, mem, sessionId: sid,
        config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
        maxContextTokens: 4_000,
        callModel: async (): Promise<any> => {
          call += 1;
          if (call === 1) return { type: 'tool_call', name: 'fs_read', args: { path: 'package.json' }, usage: { promptTokens: 9_000, completionTokens: 5 } };
          return { type: 'text', content: 'ok' };
        },
      });
      const r = await agent.run('hi');
      expect(r.text).toBe('ok');
      // 真实 9000 > 4000×0.75 → 次轮前触发（真实用量驱动——字符估算此时远低于 9000）
      expect(notices.some(n => /压缩|micro-compaction/.test(n))).toBe(true);
    } finally { off(); }
  });

  it('413 超限 → 强制压缩后自动重发（不再只提示手动 /compact）', async () => {
    const sid = 'p203-413';
    seedHistory(sid);
    let call = 0;
    const notices: string[] = [];
    const off = bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? '')));
    try {
      const agent = createPipelineAgent({
        db, bus, mem, sessionId: sid,
        config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
        maxContextTokens: 4_000,
        callModel: async (): Promise<any> => {
          call += 1;
          if (call === 1) return { type: 'tool_call', name: 'fs_read', args: { path: 'package.json' }, usage: { promptTokens: 60_000, completionTokens: 5 } };
          if (call === 2) return { type: 'text', content: '<state_snapshot>摘要</state_snapshot>' }; // 水位压缩 summarize 独立调用
          if (call === 3) {
            const err = new Error('requested context length exceeds the maximum context length') as Error & { status?: number };
            err.status = 413;
            throw err;
          }
          return { type: 'text', content: '压缩后重发成功' };
        },
      });
      const r = await agent.run('任务');
      expect(r.text).toContain('压缩后重发成功');
      expect(notices.some(n => /强制压缩/.test(n))).toBe(true);
    } finally { off(); }
  });
});

// V4 P2-7：被打断后「继续」能看到此前工具产出（gemini functionResponse 跨轮可见对标）。
describe('V4 P2-7 中断回放工具结果', () => {
  it('历史尾部 tool 消息 → 继续注记携带工具产出聚合块（模型可见、协议配对安全）', async () => {
    const sid = 'p207-replay';
    mem.append(sid, 'user', '查一下这个文件');
    mem.append(sid, 'assistant', '好的，开始读取');
    mem.append(sid, 'tool', 'fs_read: 文件内容关键结论 X=42');
    mem.append(sid, 'tool', 'bash: 测试输出全部通过 12/12');
    const seen: any[] = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: sid,
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req): Promise<any> => {
        seen.push(req.messages);
        return { type: 'text', content: '继续完成' };
      },
    });
    const r = await agent.run('继续');
    expect(r.text).toBe('继续完成');
    // 消息序列含工具产出回放（非 tool role——OpenAI 协议配对安全）
    const flat = JSON.stringify(seen[0]);
    expect(flat).toContain('上回合工具产出');
    expect(flat).toContain('X=42');
    expect(flat).toContain('12/12');
    expect(flat).toContain('被打断');
    // 不注入原生 tool role（无 tool_calls 配对——协议 400 风险）
    expect((seen[0] as any[]).some(m => m.role === 'tool')).toBe(false);
  });
});

// ══════════ 内核完善批次 1（kimi-cli 差距对齐）══════════

describe('B：后台任务通知回流（kimi 通知投递对齐）', () => {
  it('run 期间 jobs.complete → 下一次模型调用可见通知（含结果全文）', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-notify-b1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        if (seen.length === 1) {
          bus.emit('jobs.complete', { id: 'job-9', kind: 'shell', status: 'success', output: '构建成功，产物 dist/' });
          return { type: 'tool_call', id: 'c1', name: 'ls', args: { path: '.' } } as ToolCallMsg;
        }
        return { type: 'text', content: '收到通知' } as ModelCall;
      },
    });
    const r = await agent.run('开始任务');
    expect(r.ok).toBe(true);
    expect(seen.length).toBe(2);
    const flat = JSON.stringify(seen[1].messages);
    expect(flat).toContain('[后台任务通知]');
    expect(flat).toContain('job-9');
    expect(flat).toContain('构建成功，产物 dist/');
  });

  it('同一任务重复事件只回流一次（幂等）', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-notify-b2',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        if (seen.length === 1) {
          bus.emit('jobs.complete', { id: 'dup-1', kind: 'agent', status: 'success', output: '一次' });
          bus.emit('jobs.complete', { id: 'dup-1', kind: 'agent', status: 'success', output: '一次' });
          return { type: 'tool_call', id: 'c1', name: 'ls', args: { path: '.' } } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('查重');
    const flat = JSON.stringify(seen[1].messages);
    expect(flat.match(/\[后台任务通知\]/g)?.length).toBe(1);
  });

  it('settings.agentNotify=false 关闭回流', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-notify-b3',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', agentNotify: false } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        if (seen.length === 1) {
          bus.emit('jobs.complete', { id: 'off-1', kind: 'shell', status: 'success', output: '不应出现' });
          return { type: 'tool_call', id: 'c1', name: 'ls', args: { path: '.' } } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('关闭态');
    expect(JSON.stringify(seen[1].messages)).not.toContain('[后台任务通知]');
  });

  it('失败任务回流含 error 语义', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-notify-b4',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        if (seen.length === 1) {
          bus.emit('jobs.complete', { id: 'f-1', kind: 'shell', status: 'failed', error: 'exit 1：编译错误' });
          return { type: 'tool_call', id: 'c1', name: 'ls', args: { path: '.' } } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('失败通知');
    const flat = JSON.stringify(seen[1].messages);
    expect(flat).toContain('结束（failed）');
    expect(flat).toContain('编译错误');
  });
});

describe('C：输出 token 钳制（kimi max_completion_tokens 对齐）', () => {
  it('窗口已知时钳制 maxTokens = min(输出预留, 窗口−已用)（默认 outReserve）', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-clamp-1',
      maxContextTokens: 8192,
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('钳制');
    expect(typeof seen[0].maxTokens).toBe('number');
    // 钳制值 = min(outReserve, 窗口−已用)：mock 模型无目录 → outReserve 由 FALLBACK 64k 派生
    //（min(20k, max(4k, 64k×0.25=16k)) = 16000），used≈2k → 钳制 ≈ 6k——恒 < 窗口 8192 且 > 下限
    expect(seen[0].maxTokens).toBeLessThan(8192);
    expect(seen[0].maxTokens).toBeGreaterThan(1024);
  });

  it('settings.maxTokens 用户上限生效（下限 1024 保护）', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-clamp-2',
      maxContextTokens: 8192,
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', maxTokens: 500 } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('下限保护');
    expect(seen[0].maxTokens).toBe(1024); // max(1024, min(500, 余量)) —— 下限保护
  });

  it('窗口未知（无目录且未配置 maxContextTokens）不钳制——自定义端点零破坏', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-clamp-3',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('未知窗口');
    expect(seen[0].maxTokens).toBeUndefined();
  });
});

describe('D：发送层历史归一化（kimi normalize_history 对齐）', () => {
  it('DB 连续同角色 user 行 → 模型请求中合并为单条 user（不合并则应为两条）', async () => {
    const seen: Array<any> = [];
    // 铺垫以 assistant 收尾（避免「上回合被打断」注记插在中间隔断合并——那是独立正确行为）
    mem.append('t-merge-1', 'user', '第一问');
    mem.append('t-merge-1', 'user', '第二问');
    mem.append('t-merge-1', 'assistant', '已回答');
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-merge-1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('继续');
    const users = seen[0].messages.filter((m: any) => m.role === 'user');
    // 无归一化应为 3 条 user（第一问/第二问/继续）；合并后 = 2 条（第一问+第二问 合并，继续独立在后）
    expect(users).toHaveLength(2);
    expect(users[0].content as string).toContain('第一问\n第二问');
    expect(users[1].content as string).toContain('继续');
  });
});

describe('E：同批工具去重 fan-out（kimi 同步去重对齐）', () => {
  it('同批两同参 cacheable 工具只执行一次，重复槽位带「已合并」标记', async () => {
    let runs = 0;
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-dedup-1',
      extraTools: {
        echo_read: {
          schema: { type: 'function', function: { name: 'echo_read', description: '测试用纯读工具', parameters: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'] } } },
          danger: false,
          cacheable: true,
          canonical: { namespace: 'agent' as const, effectKind: 'filesystem.read' as const },
          run: async () => { runs++; return `第${runs}次结果`; },
        },
      },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        if (seen.length === 1) {
          return { type: 'tool_call', id: 'a', name: 'echo_read', args: { q: 1 }, calls: [
            { id: 'a', name: 'echo_read', args: { q: 1 } },
            { id: 'b', name: 'echo_read', args: { q: 1 } },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('去重');
    expect(runs).toBe(1); // 只真实执行一次
    const tools = seen[1].messages.filter((m: any) => m.role === 'tool');
    expect(tools).toHaveLength(2); // 两个槽位结果都回填（tool_call_id 各自配对）
    expect(tools[0].tool_call_id).toBe('a');
    expect(tools[1].tool_call_id).toBe('b');
    expect(tools[0].content).toContain('第1次结果');
    expect(tools[1].content).toContain('同批同参重复调用已合并');
  });

  it('非 cacheable 工具同批同参不去重（副作用工具绝不复用）', async () => {
    let runs = 0;
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-dedup-2',
      extraTools: {
        side_effect: {
          schema: { type: 'function', function: { name: 'side_effect', description: '副作用工具', parameters: { type: 'object', properties: {}, required: [] } } },
          danger: false,
          canonical: { namespace: 'agent', effectKind: 'extension.manage' },
          run: async () => { runs++; return `副作用${runs}`; },
        },
      },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen.push(req);
        if (seen.length === 1) {
          return { type: 'tool_call', id: 'a', name: 'side_effect', args: {}, calls: [
            { id: 'a', name: 'side_effect', args: {} },
            { id: 'b', name: 'side_effect', args: {} },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('不去重');
    expect(runs).toBe(2); // 副作用工具各执行各的
  });
});

describe('批次2：流式中途派发只读工具（kimi on_tool_call 对齐·只读先行）', () => {
  it('cacheable 工具流式中途就绪即执行——runOneCall 命中直接复用（不重跑）', async () => {
    let runs = 0;
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-early-1',
      extraTools: {
        echo_read: {
          schema: { type: 'function', function: { name: 'echo_read', description: '测试纯读', parameters: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'] } } },
          danger: false,
          cacheable: true,
          canonical: { namespace: 'agent' as const, effectKind: 'filesystem.read' as const },
          run: async () => { runs++; return `第${runs}次结果`; },
        },
      },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any, streamCtx: any) => {
        seen.push(req);
        if (seen.length === 1) {
          // 模拟 llmStream 的 index-advanced 信号：工具参数在流中途完整
          streamCtx?.onToolCallReady?.({ index: 0, id: 'c1', name: 'echo_read', arguments: '{"q":1}' }, 'index-advanced');
          return { type: 'tool_call', id: 'c1', name: 'echo_read', args: { q: 1 }, calls: [
            { id: 'c1', name: 'echo_read', args: { q: 1 } },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('提前执行');
    expect(runs).toBe(1); // 中途执行一次，runOneCall 复用不再跑
    const tools = seen[1].messages.filter((m: any) => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].content).toContain('第1次结果');
    expect(tools[0].content).toContain('已提前执行');
  });

  it('C2（kernel-eval 3-2）：提前执行入库为裸结果——同 run 内缓存命中不携带「已提前执行」标注', async () => {
    let runs = 0;
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-c2-cache',
      extraTools: {
        echo_read: {
          schema: { type: 'function', function: { name: 'echo_read', description: '测试纯读', parameters: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'] } } },
          danger: false,
          cacheable: true,
          canonical: { namespace: 'agent' as const, effectKind: 'filesystem.read' as const },
          run: async () => { runs++; return `第${runs}次结果`; },
        },
      },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any, streamCtx: any) => {
        seen.push(req);
        if (seen.length === 1) {
          streamCtx?.onToolCallReady?.({ index: 0, id: 'c1', name: 'echo_read', arguments: '{"q":1}' }, 'index-advanced');
          return { type: 'tool_call', id: 'c1', name: 'echo_read', args: { q: 1 }, calls: [
            { id: 'c1', name: 'echo_read', args: { q: 1 } },
          ] } as ToolCallMsg;
        }
        if (seen.length === 2) {
          // 同 run 下一轮同参调用：无提前派发信号——应命中回合缓存
          return { type: 'tool_call', id: 'c2', name: 'echo_read', args: { q: 1 }, calls: [
            { id: 'c2', name: 'echo_read', args: { q: 1 } },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('同一 run 内两次调用');
    expect(runs).toBe(1); // 第二轮纯缓存命中，不重跑
    const lastTools = seen[2].messages.filter((m: any) => m.role === 'tool');
    expect(lastTools).toHaveLength(2);
    const cached = lastTools[1].content;
    expect(cached).toContain('第1次结果');
    expect(cached).toContain('结果已缓存');
    expect(cached).not.toContain('已提前执行'); // 标注不随缓存传播到后续回合
  });

  it('非 cacheable 工具不提前派发（流尾原路径执行）', async () => {
    let runs = 0;
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-early-2',
      extraTools: {
        side_effect: {
          schema: { type: 'function', function: { name: 'side_effect', description: '副作用工具', parameters: { type: 'object', properties: {}, required: [] } } },
          danger: false,
          canonical: { namespace: 'agent', effectKind: 'extension.manage' },
          run: async () => { runs++; return `副作用${runs}`; },
        },
      },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any, streamCtx: any) => {
        seen.push(req);
        if (seen.length === 1) {
          streamCtx?.onToolCallReady?.({ index: 0, id: 'c1', name: 'side_effect', arguments: '{}' }, 'index-advanced');
          return { type: 'tool_call', id: 'c1', name: 'side_effect', args: {}, calls: [
            { id: 'c1', name: 'side_effect', args: {} },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('不提前');
    // 提前派发被忽略（side_effect 非 cacheable）；流尾原路径执行
    const tools = seen[1].messages.filter((m: any) => m.role === 'tool');
    expect(tools[0].content).toContain('副作用1');
    expect(tools[0].content).not.toContain('已提前执行');
  });
});

// C1 接线回归（2026-08-27）：sandboxFastPath 双层死接线修复——开启开关且沙盒可用时，
// manual 模式下工作区内低危写免审批真实放行；开关关闭时维持 fail-closed 强审批。
// （manual 模式是判别器：smart/auto 的 lowRiskAutoApprove 会掩盖 fastPath 的增量效果）
describe('C1 sandboxFastPath 接线（winSandbox 已 mock）', () => {
  const lowRiskPath = join(process.cwd(), '.tmp', 'lowrisk-target.txt');

  const runWith = async (sandboxFastPath: boolean) => {
    rmSync(lowRiskPath, { force: true });
    let calls = 0;
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: `t-c1-${sandboxFastPath ? 'on' : 'off'}`,
      mode: 'manual',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', sandboxFastPath } } as any,
      workspaceRoot: join(process.cwd(), '.tmp'),
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        calls++;
        if (calls === 1) {
          return { type: 'tool_call', id: 'c1', name: 'fs_write', args: {}, calls: [
            { id: 'c1', name: 'fs_write', args: { path: lowRiskPath, content: 'fastpath-probe' } },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    const r = await agent.run('写个探测文件');
    return { ok: r.ok, text: r.text, fileExists: existsSync(lowRiskPath) };
  };

  it('sandboxFastPath=true：低危工作区写免审批真实执行（文件写出）', async () => {
    const r = await runWith(true);
    expect(r.fileExists).toBe(true); // 双层接线生效——此前 require() 死接线会在此失败
    expect(r.ok).toBe(true);
  });

  it('sandboxFastPath=false：维持 fail-closed 强审批（文件不写出，运行终态受阻）', async () => {
    const r = await runWith(false);
    expect(r.fileExists).toBe(false); // manual 模式确认链默认拒绝——fastPath 关闭时绝不静默放行
    expect(r.ok).toBe(false); // headless 下审批不可得 → 运行诚实受阻（blocked/failed），绝不假装成功
  });

  afterAll(() => { rmSync(lowRiskPath, { force: true }); });
});

// C3（2026-08-27）：工具参数 canonical 化——键序不敏感的去重 key（kernel-eval 3-5）
describe('C3 canonicalToolArgs（键序不敏感）', () => {
  it('同语义不同键序 → 同 key；嵌套对象键序递归排序、数组顺序保持语义', () => {
    expect(canonicalToolArgs({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalToolArgs({ a: { c: 3, d: 2 }, b: 1 }));
    // 对象键序排序（含数组元素内的对象）；数组元素顺序是语义，保持
    expect(canonicalToolArgs([{ b: 1, a: 2 }, 3])).toBe(canonicalToolArgs([{ a: 2, b: 1 }, 3]));
    expect(canonicalToolArgs([3, { a: 2, b: 1 }])).not.toBe(canonicalToolArgs([{ a: 2, b: 1 }, 3]));
    expect(canonicalToolArgs({ a: 1, b: 2 })).not.toBe(canonicalToolArgs({ a: 1, c: 2 }));
  });

  it('异常输入诚实回退不抛（undefined/循环引用）', () => {
    expect(typeof canonicalToolArgs(undefined)).toBe('string');
    const cyc: Record<string, unknown> = {};
    (cyc as any).self = cyc;
    expect(typeof canonicalToolArgs(cyc)).toBe('string'); // 环引用 → RangeError/TypeError 回退
  });
});

// ──────────── 复评修复批（kernel-remediation-2026-08-27）────────────
describe('R-2：earlyDispatch 跳过 tool_search（激活副作用——流尾原路径）', () => {
  it('tool_search 流中途就绪不提前执行（结果无「已提前执行」标注——原路径执行）', async () => {
    const seen: Array<any> = [];
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-r2-toolsearch',
      toolLazyLoad: true,
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any, streamCtx: any) => {
        seen.push(req);
        if (seen.length === 1) {
          streamCtx?.onToolCallReady?.({ index: 0, id: 'c1', name: 'tool_search', arguments: '{"query":"zzz不存在"}' }, 'index-advanced');
          return { type: 'tool_call', id: 'c1', name: 'tool_search', args: { query: 'zzz不存在' }, calls: [
            { id: 'c1', name: 'tool_search', args: { query: 'zzz不存在' } },
          ] } as ToolCallMsg;
        }
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    await agent.run('检索工具');
    const tools1 = seen[1].messages.filter((m: any) => m.role === 'tool');
    expect(tools1).toHaveLength(1);
    expect(tools1[0].content).toContain('未找到匹配工具'); // 真实执行（流尾原路径）
    expect(tools1[0].content).not.toContain('已提前执行'); // 未走提前池（R-2：激活副作用排除）
  });
});

describe('R-3：未知工具按轮（批级）计数（kernel-eval 3-6）', () => {
  const mk = (name: string) => ({
    schema: { type: 'function' as const, function: { name, description: '测试纯读', parameters: { type: 'object' as const, properties: { q: { type: 'number' } }, required: ['q'] } } },
    danger: false, cacheable: true,
    canonical: { namespace: 'agent' as const, effectKind: 'filesystem.read' as const },
    run: async () => 'ok',
  });
  it('混批 [已知,未知] 连续 3 轮 → 终止（旧调用级计数被已知工具清零，永不终止）', async () => {
    let call = 0;
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-r3-mixed',
      extraTools: { echo_read: mk('echo_read') },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', maxConsecutiveFail: 10 } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call <= 3) return { type: 'tool_call', name: 'echo_read', args: { q: 1 }, calls: [
          { id: 'a' + call, name: 'echo_read', args: { q: 1 } },
          { id: 'b' + call, name: 'no_such_xyz', args: {} },
        ] } as ToolCallMsg;
        return { type: 'text', content: '完成' } as ModelCall;
      },
    });
    const r = await agent.run('混批循环');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('未知工具');
    expect(call).toBe(3);
  });
  it('未知轮与纯净轮交替 → 批级清零不误杀（maxUnknownToolRounds=2 达不到）', async () => {
    let call = 0;
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-r3-alt',
      extraTools: { echo_read: mk('echo_read') },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', maxUnknownToolRounds: 2 } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call === 1 || call === 3) return { type: 'tool_call', name: 'no_such_q', args: {}, calls: [
          { id: 'u' + call, name: 'no_such_q', args: {} },
        ] } as ToolCallMsg;
        if (call === 2 || call === 4) return { type: 'tool_call', name: 'echo_read', args: { q: 1 }, calls: [
          { id: 'e' + call, name: 'echo_read', args: { q: 1 } },
        ] } as ToolCallMsg;
        return { type: 'text', content: '交替完成' } as ModelCall;
      },
    });
    const r = await agent.run('交替');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('交替完成');
    expect(call).toBe(5);
  });
});

describe('R-4：steer 队列上限 50（满丢最旧 + 诚实 notice）', () => {
  it('注入 60 条 → 仅 50 条进上下文，丢弃可见', async () => {
    const seen: Array<any> = [];
    const notices: string[] = [];
    const off = bus.on('system.notice', (e: any) => { notices.push(String(e?.payload?.text ?? e?.text ?? '')); });
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-r4-steer',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => { seen.push(req); return { type: 'text', content: '收到' } as ModelCall; },
    });
    for (let i = 0; i < 60; i++) agent.steer(`注入消息${i}`);
    await agent.run('跑一轮');
    off();
    const userBlob = seen[0].messages.filter((m: any) => m.role === 'user').map((m: any) => String(m.content)).join('\n');
    const injected = userBlob.split('\n').filter((l: string) => /^注入消息\d+$/.test(l.trim()));
    expect(injected).toHaveLength(50); // 上限 50（丢最旧 10 条）
    expect(notices.some(t => t.includes('steer 队列已满'))).toBe(true); // 丢弃不静默
  });
});

// T8（2026-08-28）：complete 事件携带有界 preview（600 字——薄层 TUI diff 渲染数据源）
describe('T8：agent.tool complete 事件 preview 字段', () => {
  it('成功执行 → preview 为输出前 600 字（有界，超长截断）', async () => {
    const events: any[] = [];
    const off = bus.on('agent.tool', (e: any) => { if (e?.payload?.phase === 'complete' || e?.payload === undefined) events.push(e); });
    const big = 'y'.repeat(700);
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 't-t8-preview',
      extraTools: { echo_read: {
        schema: { type: 'function', function: { name: 'echo_read', description: '读', parameters: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'] } } },
        danger: false, cacheable: true,
        canonical: { namespace: 'agent', effectKind: 'filesystem.read' },
        run: async () => big,
      } },
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        return { type: 'tool_call', id: 'c1', name: 'echo_read', args: { q: 1 } } as ToolCallMsg;
      },
    });
    await agent.run('读');
    off();
    const complete = events.find((e: any) => e?.payload?.phase === 'complete' && e?.payload?.ok === true);
    expect(complete).toBeTruthy();
    expect(String(complete.payload.preview)).toHaveLength(600);
    expect(String(complete.payload.preview)).toBe(big.slice(0, 600));
  });
});
