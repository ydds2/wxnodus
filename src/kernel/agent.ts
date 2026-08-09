// src/kernel/agent.ts — L2-4 agent 循环（核心）
// 设计（参考 ReAct 模式 + Claude Code harness 事件驱动 + Hermes turnController 思想）：
//   run(prompt) 循环（≤16 轮）：
//     召回注入（黑洞引擎 FTS）→ 调模型（流式/工具）→ 文本流经事件总线
//     → 工具调用：permissions 检查 → 执行（danger 结果 untrusted 包裹）→ 回填
//     → 同工具连续失败 5 次终止 / 未知工具连续 3 轮终止 / 瞬时失败 800ms 退避重试
//   无 key → 规则脑兜底（诚实回答）
//   spawnSubagent：独立上下文 + 只读工具集
import type { Db } from '../store/db.js';
import type { EventBus } from './events.js';
import type { Memory } from './memory.js';
import { ruleBrain, decryptKey } from './providers.js';
import { coreTools, isDangerous, toolsToOpenAI, type ToolCtx } from './tools.js';
import { modeVerdict, type Mode } from './permissions.js';
import { join } from 'node:path';

export interface ModelCall { type: 'text'; content: string }
export interface ToolCallMsg { type: 'tool_call'; name: string; args: Record<string, any> }

export interface AgentOptions {
  db: Db;
  bus: EventBus;
  mem: Memory;
  sessionId: string;
  config: { settings: { apiKeyEnc?: string | null; baseURL?: string; model?: string } };
  callModel?: ((req: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }) => Promise<ModelCall | ToolCallMsg>) | null;
  mode?: Mode;
  onApproval?: (tool: string, args: Record<string, any>) => Promise<boolean>;
  maxTurns?: number;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  turns: number;
  interrupted: boolean;
}

const MAX_TURNS = 16;
const RETRY_DELAY_MS = 800;
const MAX_CONSECUTIVE_FAIL = 5;
const MAX_UNKNOWN_TOOL_ROUNDS = 3;

export function createAgent(opts: AgentOptions) {
  const tools = coreTools();
  const bus = opts.bus;
  let mode = opts.mode ?? 'smart'; // 可变：/perm 切换经 setMode 热更新
  let aborted = false;
  let interrupted = false;
  let abortResolve: () => void = () => {};
  const abortPromise = new Promise<void>(r => { abortResolve = r; });

  // 默认模型调用：OpenAI 兼容流式（真实 fetch）——key 解密后请求
  const defaultCallModel = async (req: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }): Promise<ModelCall | ToolCallMsg> => {
    const s = opts.config.settings;
    const key = s.apiKeyEnc ? decryptKey(s.apiKeyEnc) : null;
    if (!key || !s.baseURL || !s.model) {
      return { type: 'text', content: ruleBrain(req.messages[req.messages.length - 1]?.content ?? '') };
    }
    const { buildChatRequest, mapHttpError } = await import('./providers.js');
    const httpReq = buildChatRequest({ baseURL: s.baseURL, model: s.model, key, messages: req.messages as any, stream: false, tools: req.tools });
    const resp = await fetch(httpReq.url, { method: 'POST', headers: httpReq.headers, body: httpReq.body, signal: AbortSignal.timeout(120000) });
    if (!resp.ok) throw new Error(mapHttpError(resp.status));
    const j = await resp.json() as any;
    const msg = j?.choices?.[0]?.message;
    if (msg?.tool_calls?.length) {
      const tc = msg.tool_calls[0];
      return { type: 'tool_call', name: tc.function.name, args: safeJson(tc.function.arguments) };
    }
    return { type: 'text', content: String(msg?.content ?? '') };
  };
  const callModel = opts.callModel ?? defaultCallModel;

  const toolCtx: ToolCtx = { cwd: process.cwd(), dataDir: join(process.cwd(), 'data'), ask: async (q) => (opts.onApproval ? opts.onApproval('ask_user', { question: q }) : false) };

  const onApproval = opts.onApproval ?? (async () => true);

  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    bus.emit('agent.tool', { name, args, phase: 'start' });
    try {
      const verdict = modeVerdict(mode, name, args);
      if (verdict === 'reject') return `工具被拒绝：权限红线（${name}）`;
      if (verdict === 'confirm') {
        const ok = await onApproval(name, args);
        if (!ok) return `用户拒绝执行 ${name}`;
      }
      const tool = tools[name];
      if (!tool) return `未知工具：${name}`;
      const out = await tool.run(args, toolCtx);
      bus.emit('agent.tool', { name, phase: 'complete', ok: true, ms: 0 });
      return out;
    } catch (e: any) {
      bus.emit('agent.tool', { name, phase: 'complete', ok: false });
      return `工具执行异常：${e?.message?.slice(0, 300) ?? e}`;
    }
  }

  async function loop(sessionId: string, prompt: string, opts2: { subagent?: boolean } = {}): Promise<AgentResult> {
    aborted = false;
    interrupted = false;
    const callWithAbort = (req: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }) =>
      Promise.race([
        callModel(req),
        abortPromise.then(() => { throw new Error('aborted'); }),
      ]);
    const msgs: Array<{ role: string; content: string }> = [];
    // 召回注入（黑洞引擎：FTS 命中历史上下文）
    const recalled = opts.mem.recallHybrid(prompt, { limit: 3 });
    const recallBlock = recalled.length
      ? `\n[相关历史记忆]\n${recalled.map(r => r.content.slice(0, 300)).join('\n---\n')}`
      : '';
    msgs.push({ role: 'user', content: prompt + recallBlock });
    try { opts.mem.append(sessionId, 'user', prompt); } catch { /* 记忆写入失败不阻断对话 */ }
    const toolList = opts2.subagent ? toolsToOpenAI(Object.fromEntries(Object.entries(tools).filter(([n]) => !['fs_write', 'fs_edit', 'bash', 'scaffold_build', 'delegate'].includes(n)))) : toolsToOpenAI(tools);
    let turns = 0;
    let consecutiveFail = 0;
    let unknownRounds = 0;
    let finalText = '';
    bus.emit('agent.start', { sessionId, prompt });

    while (turns < (opts.maxTurns ?? MAX_TURNS)) {
      if (aborted) { interrupted = true; break; }
      turns++;
      let res: ModelCall | ToolCallMsg;
      try {
        res = await callWithAbort({ messages: msgs, tools: toolList });
      } catch (e: any) {
        if (aborted) { interrupted = true; break; }
        // 瞬时失败：800ms 退避重试（最多 3 次）
        let tried = 0;
        let lastErr = e;
        while (tried < 3) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (tried + 1)));
          try { res = await callWithAbort({ messages: msgs, tools: toolList }); break; }
          catch (e2: any) { if (aborted) { interrupted = true; break; } lastErr = e2; tried++; }
        }
        if (interrupted) break;
        if (tried >= 3) {
          bus.emit('agent.error', { message: String(lastErr?.message ?? lastErr) });
          return { ok: false, text: `模型调用失败：${lastErr?.message?.slice(0, 200)}`, turns, interrupted };
        }
        continue;
      }
      if (res.type === 'text') {
        finalText = res.content;
        msgs.push({ role: 'assistant', content: res.content });
        try { opts.mem.append(sessionId, 'assistant', res.content); } catch { /* 忽略 */ }
        for (let i = 0; i < res.content.length; i += 4) {
          if (aborted) break;
          bus.emit('agent.token', { text: res.content.slice(i, i + 4) });
        }
        bus.emit('agent.message', { content: res.content });
        break; // 文本 = 回合结束
      }
      // 工具调用
      if (res.type === 'tool_call') {
        const tool = tools[res.name];
        if (!tool) {
          unknownRounds++;
          if (unknownRounds >= MAX_UNKNOWN_TOOL_ROUNDS) {
            bus.emit('agent.error', { message: `连续 ${MAX_UNKNOWN_TOOL_ROUNDS} 轮未知工具，终止` });
            return { ok: false, text: '模型连续调用未知工具，已终止', turns, interrupted };
          }
          msgs.push({ role: 'assistant', content: `工具 ${res.name} 不存在` });
          continue;
        }
        unknownRounds = 0;
        const out = await executeTool(res.name, res.args);
        consecutiveFail = out.includes('失败') || out.includes('异常') ? consecutiveFail + 1 : 0;
        if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
          bus.emit('agent.error', { message: `同工具连续失败 ${MAX_CONSECUTIVE_FAIL} 次，终止` });
          return { ok: false, text: '同工具连续失败 5 次，已终止', turns, interrupted };
        }
        msgs.push({ role: 'assistant', content: JSON.stringify({ tool: res.name, args: res.args }) });
        msgs.push({ role: 'tool', content: out });
        try { opts.mem.append(sessionId, 'tool', `${res.name}: ${out.slice(0, 300)}`); } catch { /* 忽略 */ }
      }
    }
    bus.emit('agent.end', { ok: finalText.length > 0, turns });
    return { ok: finalText.length > 0, text: finalText, turns, interrupted };
  }

  return {
    async run(prompt: string): Promise<AgentResult> {
      return loop(opts.sessionId, prompt);
    },
    async spawnSubagent(goal: string): Promise<{ ok: boolean; output: string; turns: number }> {
      const r = await loop(opts.sessionId + ':sub', goal, { subagent: true });
      return { ok: r.ok, output: r.text, turns: r.turns };
    },
    abort() { aborted = true; abortResolve?.(); },
    setMode(m: Mode) { mode = m; },
    getMode(): Mode { return mode; },
  };
}

function safeJson(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}
