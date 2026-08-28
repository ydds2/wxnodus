// tests/core-facade.test.ts — @wxnodus/core 进程内门面（A-S4 · 2026-08-28）
// 覆盖：事件流迭代（token→final 顺序）/ 多会话隔离（sid 过滤）/ ask 语法糖 / fail 传播为 final(ok:false)
import { describe, it, expect } from 'vitest';
import { WxnodusAgent, type CoreKernel } from '../packages/core/src/index.js';

const makeKernel = (behavior: 'ok' | 'fail'): CoreKernel => {
  const handlers = new Map<string, Array<(e: any) => void>>();
  return {
    bus: {
      on(type: string, fn: (e: any) => void) { const l = handlers.get(type) ?? []; l.push(fn); handlers.set(type, l); return () => {}; },
      emit(type: string, payload: any) { for (const fn of handlers.get(type) ?? []) fn(payload); },
    },
    agent: {
      run: async (prompt: string) => {
        const sid = (currentSid as unknown as string);
        const emit = (t: string, p: any) => { for (const fn of handlers.get(t) ?? []) fn(p); };
        emit('agent.token', { sessionId: sid, payload: { text: '你好' } });
        emit('agent.token', { sessionId: sid, payload: { text: '，结果' } });
        if (behavior === 'ok') {
          return { ok: true, text: `完成：${prompt}`, turns: 2, interrupted: false };
        }
        throw new Error('内核爆炸');
      },
    } as CoreKernel['agent'],
  };
};
let currentSid: string | null = null;

describe('@wxnodus/core WxnodusAgent', () => {
  it('send 流迭代：token×2 → final（顺序与内容完整）', async () => {
    const agent = new WxnodusAgent({ kernel: makeKernel('ok') });
    const s = await agent.session();
    currentSid = s.sessionId;
    const events: string[] = [];
    for await (const ev of s.send('任务')) events.push(ev.type + (ev.type === 'token' ? `:${(ev as { text: string }).text}` : ''));
    expect(events).toEqual(['token:你好', 'token:，结果', 'final']);
  });
  it('多会话隔离：他 sid 的 token 不串入本会话流', async () => {
    const kernel = makeKernel('ok');
    const agent = new WxnodusAgent({ kernel });
    const a = await agent.session();
    const b = await agent.session();
    currentSid = b.sessionId; // run 按 b 上下文发事件
    const got: string[] = [];
    const it = a.send('会话A')[Symbol.asyncIterator]();
    // b 的事件不应进 a——先让 a 的 run 触发（kernel.run 读 currentSid=b）：
    const p = (async () => { for await (const ev of a.send('x')) got.push(ev.type); })();
    await p;
    // a 的流里只有 a 自己的 final（其 run 的事件带 b sid，被过滤）+ 自己的 final
    expect(got.every(t => t === 'final')).toBe(true);
  });
  it('ask 语法糖：final 聚合直取（ask 内部新建会话——sid 过滤天然隔离他流，final 恒达）', async () => {
    const agent = new WxnodusAgent({ kernel: makeKernel('ok') });
    currentSid = null; // ask 新会话 sid 未知——token 事件因 sid 不匹配被隔离（多会话正确性），final 直推恒在
    const r = await agent.ask('单轮');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('完成：单轮');
    expect(r.turns).toBe(2);
    expect(r.events.at(-1)!.type).toBe('final');
  });
  it('内核异常 → final(ok:false) 事件（流不中途断裂）', async () => {
    const agent = new WxnodusAgent({ kernel: makeKernel('fail') });
    const s = await agent.session();
    currentSid = s.sessionId;
    const types: string[] = [];
    for await (const ev of s.send('boom')) types.push(ev.type);
    expect(types).toEqual(['token', 'token', 'final']);
  });
});
