// tests/hermes-gateway-interactive.test.ts — 审批/澄清/密钥桥全链路（内核回调 ⇄ WS 事件 ⇄ TUI respond）
// 断链根因回归（2026-08-28 修通）：hermes 迁移初版 pending 表从未填充、approval.request/
// clarify.request/secret.request 事件从不广播、respond 恒假成功——内核 confirm/plan 工具
// 在 TUI 模式下被静默 fail-closed 拒绝。本测试钉死完整链路与 fail-closed 语义。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createHermesGateway, type HermesGatewayDeps, type HermesGatewayHandle } from '../src/hermes-gateway/server.js';

interface GatewayEvent { type: string; payload?: Record<string, any>; session_id?: string }
type EventWaiter = { test(e: GatewayEvent, idx: number): boolean; resolve(e: GatewayEvent): void };

function fakeDeps(over: Partial<HermesGatewayDeps> = {}): HermesGatewayDeps {
  return {
    db: { prepare: () => { throw new Error('测试无 db'); } } as never,
    bus: { on: () => () => {} },
    agent: {
      run: async () => ({ ok: true, text: '', turns: 0 }),
      abort() {}, steer: () => true, getSessionId: () => 'test-session',
    },
    commandBus: { execute: async () => ({ ok: true }) },
    config: { get: () => ({}) },
    ...over,
  };
}

/** 连接网关，收集事件帧；resolve 事件等待器 + respond 发送器 */
function connect(port: number) {
  const events: GatewayEvent[] = [];
  const waiters: Array<EventWaiter> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const opened = new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', e => rej(e));
  });
  ws.on('message', raw => {
    let frame: any; try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame?.method !== 'event') return;
    const ev = { ...(frame.params ?? {}) } as GatewayEvent;
    const idx = events.push(ev) - 1;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.test(ev, idx)) { waiters[i]!.resolve(ev); waiters.splice(i, 1); }
    }
  });
  return {
    ws, opened, events,
    /** 等待 type 帧；afterIdx 起查（默认 0=含历史）——同一 type 多帧时传 events.length 快照跳旧帧 */
    waitFor(type: string, timeoutMs = 3000, afterIdx = 0): Promise<GatewayEvent> {
      const hit = events.slice(afterIdx).find(e => e.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`等待事件 ${type} 超时（已收：${events.map(e => e.type).join(',')}）`)), timeoutMs);
        waiters.push({ test: (e, idx) => e.type === type && idx >= afterIdx, resolve: e => { clearTimeout(t); res(e); } });
      });
    },
    respond(method: string, params: Record<string, unknown>): Promise<any> {
      return new Promise((res, rej) => {
        const id = `r${Math.random().toString(36).slice(2)}`;
        const t = setTimeout(() => { ws.off('message', onMsg); rej(new Error(`respond ${method} 超时`)); }, 3000);
        // on+匹配（once 会被并发 broadcast 事件帧消费掉——RPC 响应帧无人接）
        const onMsg = (raw: WebSocket.RawData) => {
          try { const f = JSON.parse(String(raw)); if (f.id === id) { clearTimeout(t); ws.off('message', onMsg); res(f); } } catch { /* 非 JSON */ }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
      });
    },
  };
}

describe('hermes-gateway 审批/澄清/密钥桥（全链路）', () => {
  let hg: HermesGatewayHandle;
  let cli: ReturnType<typeof connect>;

  afterEach(async () => {
    try { cli?.ws.close(); } catch { /* 已关闭 */ }
    if (hg) await hg.close();
  });

  beforeEach(() => { hg = undefined as never; });

  async function boot(over: Partial<HermesGatewayDeps> = {}) {
    hg = await createHermesGateway(fakeDeps(over));
    cli = connect(hg.port);
    await cli.opened;
    await cli.waitFor('gateway.ready');
  }

  it('approval 全链路：approval.request（单槽无 request_id）→ respond {choice} → resolve', async () => {
    await boot();
    const p = hg.requestApproval('bash', { command: 'rm -rf dist' });
    const ev = await cli.waitFor('approval.request');
    expect(ev.payload!.command).toBe('rm -rf dist');
    expect(ev.payload!.description).toContain('bash');
    expect(ev.payload!.choices).toEqual(['once', 'session', 'always', 'deny']);
    expect(ev.payload!.request_id).toBeUndefined(); // hermes 单槽协议——不带 request_id
    const r = await cli.respond('approval.respond', { choice: 'session', session_id: 'test-session' });
    expect(r.result).toEqual({ ok: true, handled: true });
    await expect(p).resolves.toBe('session');
  });

  it('approval choice 归一化：once/always→allow、deny 与未知→deny', async () => {
    await boot();
    for (const [raw, want] of [['once', 'allow'], ['always', 'allow'], ['deny', 'deny'], ['bogus', 'deny']] as const) {
      const p = hg.requestApproval('fs_write', { path: 'a.txt' });
      await cli.waitFor('approval.request');
      await cli.respond('approval.respond', { choice: raw });
      await expect(p).resolves.toBe(want);
    }
  });

  it('approval 对象摘要：文件工具显 path、无参工具显工具名', async () => {
    await boot();
    const p1 = hg.requestApproval('fs_edit', { path: 'C:/x/y.ts' });
    const e1 = await cli.waitFor('approval.request');
    expect(e1.payload!.command).toBe('C:/x/y.ts');
    await cli.respond('approval.respond', { choice: 'deny' });
    await expect(p1).resolves.toBe('deny');
    const mark = cli.events.length; // 快照——第二次 approval 跳过历史帧
    const p2 = hg.requestApproval('http_get', {});
    const e2 = await cli.waitFor('approval.request', 3000, mark);
    expect(e2.payload!.command).toBe('http_get');
    await cli.respond('approval.respond', { choice: 'once' });
    await expect(p2).resolves.toBe('allow');
  });

  it('clarify 全链路：clarify.request {request_id, question, choices} → respond {answer} → resolve', async () => {
    await boot();
    const p = hg.requestClarify('选哪个数据库？', ['sqlite', 'postgres']);
    const ev = await cli.waitFor('clarify.request');
    expect(ev.payload!.question).toBe('选哪个数据库？');
    expect(ev.payload!.choices).toEqual(['sqlite', 'postgres']);
    expect(typeof ev.payload!.request_id).toBe('string');
    const r = await cli.respond('clarify.respond', { answer: 'sqlite', request_id: ev.payload!.request_id });
    expect(r.result).toEqual({ ok: true, handled: true });
    await expect(p).resolves.toBe('sqlite');
  });

  it('clarify 无选项：choices 为 null（hermes 协议——TUI 进自由输入模式）', async () => {
    await boot();
    const p = hg.requestClarify('补充说明？');
    const ev = await cli.waitFor('clarify.request');
    expect(ev.payload!.choices).toBeNull();
    await cli.respond('clarify.respond', { answer: '随便', request_id: ev.payload!.request_id });
    await expect(p).resolves.toBe('随便');
  });

  it('secret 全链路：secret.request {env_var, prompt, request_id} → respond {value} → resolve', async () => {
    await boot();
    const p = hg.requestSecretInput('secret', '请输入 API 密钥', 'WXN_KEY');
    const ev = await cli.waitFor('secret.request');
    expect(ev.payload!.env_var).toBe('WXN_KEY');
    expect(ev.payload!.prompt).toBe('请输入 API 密钥');
    const r = await cli.respond('secret.respond', { request_id: ev.payload!.request_id, value: 'sk-test-123' });
    expect(r.result).toEqual({ ok: true, handled: true });
    await expect(p).resolves.toBe('sk-test-123');
  });

  it('sudo 全链路：sudo.request {request_id} → respond {password}（password 字段——TUI 实测形状）→ resolve', async () => {
    await boot();
    const p = hg.requestSecretInput('sudo', 'sudo 密码');
    const ev = await cli.waitFor('sudo.request');
    expect(typeof ev.payload!.request_id).toBe('string');
    const r = await cli.respond('sudo.respond', { password: 'hunter2', request_id: ev.payload!.request_id });
    expect(r.result).toEqual({ ok: true, handled: true });
    await expect(p).resolves.toBe('hunter2');
  });

  it('secret 空输入归一 null（bridges onSecretRequest 语义：null=不可用→工具拒绝）', async () => {
    await boot();
    const p = hg.requestSecretInput('secret', '密钥', 'K');
    const ev = await cli.waitFor('secret.request');
    await cli.respond('secret.respond', { request_id: ev.payload!.request_id, value: '' });
    await expect(p).resolves.toBeNull();
  });

  it('respond 未知 request_id：ok 但 handled:false（不假成功）', async () => {
    await boot();
    const r = await cli.respond('clarify.respond', { answer: 'x', request_id: 'no-such-rid' });
    expect(r.result).toEqual({ ok: true, handled: false });
    const r2 = await cli.respond('approval.respond', { choice: 'once' }); // 无 pending——单槽取不到
    expect(r2.result).toEqual({ ok: true, handled: false });
  });

  it('超时 fail-closed（KF-010 同款）：approval→deny、clarify→\'\'、secret→null + secret.expire', async () => {
    await boot({ requestTimeoutMs: 1_000 }); // 下限 1000ms（Math.max 保护）
    const pa = hg.requestApproval('bash', { command: 'x' });
    const pc = hg.requestClarify('问题');
    const ps = hg.requestSecretInput('secret', '密钥', 'K');
    await cli.waitFor('approval.request');
    await cli.waitFor('clarify.request');
    await cli.waitFor('secret.request');
    await expect(pa).resolves.toBe('deny');
    await expect(pc).resolves.toBe('');
    await expect(ps).resolves.toBeNull();
    await cli.waitFor('secret.expire'); // 面板经 expire 事件回收
    // 超时后再 respond：ok 但 handled:false（TUI 关面板，内核已 fail-closed）
    const ev = cli.events.find(e => e.type === 'clarify.request');
    const r = await cli.respond('clarify.respond', { answer: '迟到的答案', request_id: ev?.payload?.request_id });
    expect(r.result.handled).toBe(false);
  });

  it('回合结束清理：agent.run 结束时未应答请求 fail-closed 释放 + sudo.expire 广播', async () => {
    let fireTool: (() => void) | null = null;
    await boot({
      agent: {
        run: async () => {
          // 模拟回合内工具触发 sudo 请求后 run 直接结束（中断路径）——用户未应答
          const pending = hg.requestSecretInput('sudo', '密码');
          fireTool = () => { void pending; };
          fireTool();
          return { ok: true, text: 'done', turns: 1 };
        },
        abort() {}, steer: () => true, getSessionId: () => 'test-session',
      },
    });
    const r = await cli.respond('command.dispatch', { text: '跑一个需要 sudo 的任务' });
    expect(r.result.ok).toBe(true);
    await cli.waitFor('sudo.request');
    await cli.waitFor('sudo.expire'); // run 结束 fail-close 广播
    const note = await cli.waitFor('notification.show');
    expect(String(note.payload!.text)).toContain('fail-closed');
  });

  it('close()：网关关闭释放全部 pending（进程退出不留悬空 promise）', async () => {
    await boot();
    const pa = hg.requestApproval('bash', { command: 'x' });
    const ps = hg.requestSecretInput('secret', 'k', 'K');
    await cli.waitFor('approval.request');
    await cli.waitFor('secret.request');
    await hg.close();
    await expect(pa).resolves.toBe('deny');
    await expect(ps).resolves.toBeNull();
  });
});
