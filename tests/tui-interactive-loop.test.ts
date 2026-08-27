// tests/tui-interactive-loop.test.ts — P2 / Q1（2026-08-27）：薄层 TUI 交互循环（流驱动）
// 覆盖：横幅 / agent 回合渲染（token 流式 + 终态行）/ 斜杠命令 / 审批应答（wire 同契约） / /exit 收口。
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { startInteractiveLoop } from '../src/presentation/tui/interactiveLoop.js';

const makeBus = () => {
  const handlers = new Map<string, Array<(e: any) => void>>();
  return {
    on(type: string, h: (e: any) => void) { const list = handlers.get(type) ?? []; list.push(h); handlers.set(type, list); return () => {}; },
    emit(type: string, e: any) { for (const h of handlers.get(type) ?? []) h(e); },
  };
};

const start = (deps: Record<string, unknown> = {}) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: string[] = [];
  stdout.on('data', (c: Buffer) => out.push(String(c)));
  const gatewayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bus = makeBus();
  let setOnRequest: ((ev: any) => void) | null = null;
  const finished = startInteractiveLoop({
    sessionId: 'tui-test',
    modelLabel: 'mock-model',
    gateway: { request: async (method: string, params: Record<string, unknown>) => { gatewayCalls.push({ method, params }); return { ok: true }; }, requestApproval: async () => 'deny' },
    bus,
    runInvocation: {
      invoke(input: { kind: string; runId?: string }) {
        const runId = input.runId ?? 'run';
        queueMicrotask(() => {
          bus.emit('agent.token', { runId, payload: { text: '你好，测试' } });
          bus.emit('agent.end', { runId });
        });
        return { completion: Promise.resolve({ status: 'succeeded', value: { ok: true } }), cancel() {} };
      },
    },
    commandBus: { execute: async (input: string) => ({ output: `命令结果：${input}` }) },
    routeInput: async () => ({ kind: 'chat' }),
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    setOnRequest: (fn: (ev: any) => void) => { setOnRequest = fn; },
    ...deps,
  });
  const write = (line: string) => stdin.write(line + '\n');
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  return {
    write, sleep,
    text: () => out.join(''),
    gatewayCalls: () => gatewayCalls,
    getOnRequest: () => setOnRequest,
    finish: async () => { stdin.end(); await finished; },
  };
};

describe('薄层 TUI 交互循环', () => {
  it('横幅 + agent 回合（token 流式渲染 + ✓ 完成终态）+ /exit 收口', async () => {
    const t = start();
    t.write('你好');
    await t.sleep(30);
    t.write('/exit');
    await t.finish();
    expect(t.text()).toContain('WxNodus 交互模式');
    expect(t.text()).toContain('mock-model');
    expect(t.text()).toContain('你好，测试'); // agent.token 流式渲染
    expect(t.text()).toContain('✓ 完成');
  });

  it('斜杠命令直走 commandBus（结果输出）', async () => {
    const t = start();
    t.write('/model status');
    await t.sleep(30);
    t.write('/exit');
    await t.finish();
    expect(t.text()).toContain('命令结果：/model status');
  });

  it('审批应答走 wire 同契约：approval.request → y → approval.respond allow', async () => {
    const t = start();
    await t.sleep(10);
    // 组合根注入路径：网关广播 → 循环切换应答模式
    t.getOnRequest()!({ type: 'approval.request', request_id: 'r1', tool: 'fs_write', args: { path: 'a.txt' } });
    await t.sleep(10);
    expect(t.text()).toContain('⏸ 审批'); // 提问已渲染
    t.write('y');
    await t.sleep(10);
    t.write('/exit');
    await t.finish();
    const calls = t.gatewayCalls();
    expect(calls.some(c => c.method === 'approval.respond' && c.params.request_id === 'r1' && c.params.answer === 'allow')).toBe(true);
  });

  it('非 y/s 输入 → deny（fail-closed 语义）', async () => {
    const t = start();
    await t.sleep(10);
    t.getOnRequest()!({ type: 'approval.request', request_id: 'r2', tool: 'bash', args: { command: 'rm -rf x' } });
    await t.sleep(10);
    t.write('n');
    await t.sleep(10);
    t.write('/exit');
    await t.finish();
    expect(t.gatewayCalls().some(c => c.method === 'approval.respond' && c.params.request_id === 'r2' && c.params.answer === 'deny')).toBe(true);
  });
});
