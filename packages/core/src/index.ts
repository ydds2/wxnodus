// packages/core/src/index.ts — @wxnodus/core 进程内门面（A-S4 · 2026-08-28）
// 形态参考 gemini-cli sdk（GeminiCliAgent 进程内 Agent 类 + sendStream 流迭代器——实现原创）：
//   const agent = new WxnodusAgent({ cwd }); const s = agent.session(); for await (const ev of s.send('hi')) {}
// 零云端：进程内直驱 kernel 组合（createAgent+coreTools+事件总线），无网络、无子进程。
// 事件面：send() 异步迭代产出 { type: 'token'|'reasoning'|'tool'|'notice'|'final', ... }——
//   与 --wire stream-json 同族分类学（协议事件直译，无第二套语义）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WxnodusAgentOptions {
  /** 工作目录（缺省 process.cwd()） */
  cwd?: string;
  /** 数据目录（缺省临时目录——嵌入门面默认隔离，不污染 CLI 用户数据） */
  dataDir?: string;
  /** 模型设置（settings 直传——如 { model, baseURL, apiKeyEnc }） */
  settings?: Record<string, unknown>;
  /** 模式（缺省 yolo：嵌入场景默认无审批——写操作仍受红线/沙箱约束） */
  mode?: 'yolo' | 'smart' | 'manual';
  /** 内核装配注入（测试替身/自定义组合） */
  kernel?: CoreKernel;
}

export interface CoreKernel {
  agent: {
    run(prompt: string, opts?: { images?: unknown[]; goalLoop?: boolean; signal?: AbortSignal }): Promise<{ ok: boolean; text: string; turns: number; interrupted?: boolean }>;
  };
  bus: { on(type: string, fn: (e: any) => void): () => void; emit?(type: string, payload: unknown): unknown };
}

export type WxnodusEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; phase: 'start' | 'complete'; ok?: boolean }
  | { type: 'notice'; text: string }
  | { type: 'final'; ok: boolean; text: string; turns: number };

/** 默认内核装配：createAgent + coreTools 直驱（agentToolRunner 经生产管线） */
async function buildDefaultKernel(opts: WxnodusAgentOptions): Promise<CoreKernel> {
  const cwd = opts.cwd ?? process.cwd();
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'wxn-core-'));
  const { openDB } = await import('../../../src/store/db.js');
  const { createEventBus } = await import('../../../src/kernel/events.js');
  const { createMemory } = await import('../../../src/kernel/memory.js');
  const db = openDB(dataDir);
  const bus = createEventBus(dataDir);
  const mem = createMemory(db);
  const { createPipelineAgentLikeRunner } = await import('./runner.js');
  const runner = await createPipelineAgentLikeRunner({ db, dataDir, workspaceRoot: cwd });
  const { createAgent } = await import('../../../src/kernel/agent.js');
  const agent = createAgent({
    db, bus, mem,
    sessionId: `core-${randomUUID().slice(0, 8)}`,
    config: { settings: { model: 'mock', ...(opts.settings ?? {}) } } as never,
    workspaceRoot: cwd,
    mode: opts.mode ?? 'yolo',
    agentToolRunner: runner,
  } as never);
  return { agent, bus };
}

export class WxnodusSession {
  private constructor(readonly sessionId: string, private readonly kernel: CoreKernel) {}
  static create(kernel: CoreKernel): WxnodusSession {
    return new WxnodusSession(`core-${randomUUID().slice(0, 8)}`, kernel);
  }

  /**
   * 单轮发送——异步迭代产出事件流（token/reasoning/tool/notice）直至 final。
   * 事件经 kernel 总线按会话过滤（多会话/后台任务不串扰）。
   */
  async *send(prompt: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<WxnodusEvent> {
    const offs: Array<() => void> = [];
    const queue: WxnodusEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (ev: WxnodusEvent) => { queue.push(ev); wake?.(); };
    const sid = this.sessionId;
    offs.push(this.kernel.bus.on('agent.token', (e: any) => { if (e?.sessionId === sid || e?.payload?.session_id === sid) push({ type: 'token', text: String(e?.payload?.text ?? e?.text ?? '') }); }));
    offs.push(this.kernel.bus.on('reasoning.delta', (e: any) => { if (e?.sessionId === sid || e?.payload?.session_id === sid) push({ type: 'reasoning', text: String(e?.payload?.text ?? '') }); }));
    offs.push(this.kernel.bus.on('agent.tool', (e: any) => {
      const p = e?.payload ?? {};
      if (p.session_id && p.session_id !== sid) return;
      push({ type: 'tool', name: String(p.name ?? ''), phase: p.phase === 'complete' ? 'complete' : 'start', ...(p.ok !== undefined ? { ok: p.ok === true } : {}) });
    }));
    offs.push(this.kernel.bus.on('system.notice', (e: any) => { if (!e?.runId || e?.sessionId === sid) push({ type: 'notice', text: String(e?.payload?.text ?? '') }); }));

    const runP = this.kernel.agent.run(prompt, { signal: opts.signal } as never);
    void runP.then(r => { push({ type: 'final', ok: r.ok, text: r.text, turns: r.turns }); done = true; wake?.(); }, err => { push({ type: 'final', ok: false, text: String((err as Error)?.message ?? err), turns: 0 }); done = true; wake?.(); });

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
        await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 250); }); // 有界等待（防丢尾事件）
      }
    } finally { for (const off of offs) off(); }
  }
}

export class WxnodusAgent {
  private kernelPromise: Promise<CoreKernel> | null = null;
  constructor(private readonly opts: WxnodusAgentOptions = {}) {}

  private kernel(): Promise<CoreKernel> {
    this.kernelPromise ??= this.opts.kernel
      ? Promise.resolve(this.opts.kernel)
      : buildDefaultKernel(this.opts);
    return this.kernelPromise;
  }

  /** 新建会话（多会话并存——每会话独立 sessionId 过滤） */
  async session(): Promise<WxnodusSession> {
    return WxnodusSession.create(await this.kernel());
  }

  /** 便捷单轮：collect 事件取 final 文本（等价 send 迭代至耗尽的语法糖） */
  async ask(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<{ ok: boolean; text: string; turns: number; events: WxnodusEvent[] }> {
    const s = await this.session();
    const events: WxnodusEvent[] = [];
    let final: WxnodusEvent | null = null;
    for await (const ev of s.send(prompt, opts)) { events.push(ev); if (ev.type === 'final') final = ev; }
    const f = final as Extract<WxnodusEvent, { type: 'final' }> | null;
    return { ok: f?.ok ?? false, text: f?.text ?? '', turns: f?.turns ?? 0, events };
  }
}

export { PROTOCOL_VERSION as CORE_PROTOCOL_VERSION } from '../../../src/protocol/version.js';
