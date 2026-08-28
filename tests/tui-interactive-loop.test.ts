// tests/tui-interactive-loop.test.ts — P2 / Q1（2026-08-27）：薄层 TUI 交互循环（流驱动）
// 覆盖：横幅 / agent 回合渲染（token 流式 + 终态行）/ 斜杠命令 / 审批应答（wire 同契约） / /exit 收口。
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { startInteractiveLoop, slashCompleter } from '../src/presentation/tui/interactiveLoop.js';

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
    bus, write, sleep,
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

  it('kimi 风格（2026-08-28）：reasoning.delta 触发折叠思考行（修复死接线——agent 发 reasoning.delta 而非 agent.reasoning.delta）', async () => {
    let emitReasoning: ((runId: string) => void) | null = null;
    const bus = makeBus();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on('data', (c: Buffer) => out.push(String(c)));
    let setOnRequest: ((ev: any) => void) | null = null;
    const finished = startInteractiveLoop({
      sessionId: 'tui-test', modelLabel: 'mock-model',
      gateway: { request: async () => ({ ok: true }), requestApproval: async () => 'deny' },
      bus,
      runInvocation: {
        invoke(input: { kind: string; runId?: string }) {
          const runId = input.runId ?? 'run';
          emitReasoning = (rid: string) => {
            bus.emit('reasoning.delta', { runId: rid, payload: { text: '思考内容' } });
            bus.emit('agent.tool', { runId: rid, payload: { name: 'fs_read', args: { path: 'a.txt' }, phase: 'start', toolId: 't1' } });
            bus.emit('agent.tool', { runId: rid, payload: { name: 'fs_read', phase: 'complete', ok: true, ms: 12, toolId: 't1' } });
            bus.emit('system.notice', { runId: rid, payload: { level: 'error', text: '失败标题\n正文' } });
            bus.emit('agent.token', { runId: rid, payload: { text: '你好，测试' } });
            bus.emit('agent.end', { runId: rid });
          };
          return { completion: new Promise(res => queueMicrotask(() => { emitReasoning?.(runId); res({ status: 'succeeded', value: { ok: true } }); })), cancel() {} };
        },
      },
      commandBus: { execute: async () => ({ output: '' }) },
      routeInput: async () => ({ kind: 'chat' }),
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      setOnRequest: (fn: (ev: any) => void) => { setOnRequest = fn; },
    });
    stdin.write('你好\n');
    await new Promise(r => setTimeout(r, 40));
    stdin.write('/exit\n');
    await finished;
    const text = out.join('');
    expect(text).toContain('▸ 推理');           // 折叠思考行已触发（此前死接线永不触发）
    expect(text).toContain('Using fs_read (a.txt)'); // kimi 工具头行 + 关键参数提取
    expect(text).toContain('fs_read 完成 · 12ms');   // 结果行
    expect(text).toContain('失败标题');          // 通知标题
    expect(text).toContain('你好，测试');
    expect(text).toContain('✓ 完成');
  });
});

// T8（2026-08-28）：工具完成事件的 diff preview → 红绿块渲染（非 TTY 纯文本路径）

describe('T8：工具 diff 回显（事件 preview 消费）', () => {
  it('agent.tool complete 携带统一 diff preview → 渲染 @@/+/- 行', async () => {
    let busRef: { emit(type: string, e: any): void } | null = null;
    const t = start({
      runInvocation: {
        invoke(input: { runId?: string }) {
          const runId = input.runId ?? 'run';
          queueMicrotask(() => {
            busRef?.emit('agent.tool', { runId, payload: { name: 'fs_edit', phase: 'complete', ok: true, ms: 4, preview: '已替换 src/x.ts 中 1 处\n@@ -3,1 +3,1 @@\n-旧内容\n+新内容' } });
            busRef?.emit('agent.end', { runId });
          });
          return { completion: Promise.resolve({ status: 'succeeded', value: { ok: true } }), cancel() {} };
        },
      },
    });
    busRef = t.bus;
    t.write('改一下');
    await t.sleep(40);
    const text = t.text();
    expect(text).toContain('@@ -3,1 +3,1 @@');
    expect(text).toContain('-旧内容');
    expect(text).toContain('+新内容');
    expect(text).toContain('fs_edit 完成');
    await t.finish();
  });
  it('preview 无 diff 标记 → 不渲染块（普通输出不误判）', async () => {
    let busRef: { emit(type: string, e: any): void } | null = null;
    const t = start({
      runInvocation: {
        invoke(input: { runId?: string }) {
          const runId = input.runId ?? 'run';
          queueMicrotask(() => {
            busRef?.emit('agent.tool', { runId, payload: { name: 'ls', phase: 'complete', ok: true, ms: 2, preview: 'file1.ts\nfile2.ts' } });
            busRef?.emit('agent.end', { runId });
          });
          return { completion: Promise.resolve({ status: 'succeeded', value: { ok: true } }), cancel() {} };
        },
      },
    });
    busRef = t.bus;
    t.write('列目录');
    await t.sleep(40);
    expect(t.text()).toContain('ls 完成');
    expect(t.text()).not.toContain('@@');
    await t.finish();
  });
});

// T11（2026-08-28）：Tab 斜杠命令补全（纯函数契约）
describe('T11：slashCompleter', () => {
  const cmds = ['/help', '/memory', '/model', '/model set-key'];
  it('唯一前缀命中 → 补全并附空格', () => {
    const hea = cmds[0]!.slice(0, 4); // '/hel'——程序构造（字面量免疫隐形字符）
    expect(slashCompleter(hea, cmds)).toEqual([['/help '], hea]);
    const ms = cmds[3]!.slice(0, 10); // '/model set'
    expect(slashCompleter(ms, cmds)).toEqual([['/model set-key '], ms]);
  });
  it('多命中 → 返回全列表（readline 列显 + 公共前缀推进）；非 slash 零干预', () => {
    expect(slashCompleter('/m', cmds)).toEqual([['/memory', '/model', '/model set-key'], '/m']);
    expect(slashCompleter('/zzz', cmds)).toEqual([[], '/zzz']);
    expect(slashCompleter('普通输入', cmds)).toEqual([[], '普通输入']);
  });
});

// T12（2026-08-28）：反斜杠续行多行输入（… 提示符 + 缓冲收口提交）
describe('T12：续行多行输入', () => {
  it('尾部单反斜杠续行——缓冲合并为单次提交（换行连接）', async () => {
    const prompts: string[] = [];
    const t = start({
      runInvocation: {
        invoke(input: { kind: string; prompt?: string; runId?: string }) {
          prompts.push(String(input.prompt ?? ''));
          queueMicrotask(() => busRef?.emit('agent.end', { runId: input.runId ?? 'run' }));
          return { completion: Promise.resolve({ status: 'succeeded', value: { ok: true } }), cancel() {} };
        },
      },
    });
    var busRef = t.bus; // eslint-disable-line
    t.write('第一行' + String.fromCharCode(92)); // 尾部单反斜杠（\）——heredoc 转义不可靠，显式构造
    await t.sleep(20);
    t.write('第二行');
    await t.sleep(40);
    expect(prompts).toEqual(['第一行\n第二行']); // 一次提交、换行连接、反斜杠剥离
    await t.finish();
  });
  it('偶数反斜杠为字面量——不续行直接提交', async () => {
    const prompts: string[] = [];
    const t = start({
      runInvocation: {
        invoke(input: { kind: string; prompt?: string; runId?: string }) {
          prompts.push(String(input.prompt ?? ''));
          queueMicrotask(() => busRef2?.emit('agent.end', { runId: input.runId ?? 'run' }));
          return { completion: Promise.resolve({ status: 'succeeded', value: { ok: true } }), cancel() {} };
        },
      },
    });
    var busRef2 = t.bus; // eslint-disable-line
    t.write('路径 C:\\目录');
    await t.sleep(40);
    expect(prompts).toEqual(['路径 C:\\目录']);
    await t.finish();
  });
});
