// tests/v4-gateway-pending.test.ts — V4 P2-4：审批/澄清 pending 多路化
// ① 并发双审批各自独立可答（旧单槽：第二个覆盖第一个 → 被覆盖方永久挂起）
// ② 超时 fail-closed（审批 deny / 澄清空串）
// ③ clarify.respond 误答审批死代码已消除；cancelForeground 全清两表
import { describe, it, expect, vi } from 'vitest';

type Published = { type: string; payload: Record<string, unknown> };

function makeGateway() {
  const published: Published[] = [];
  const gateway = {
    pendingApprovals: new Map(),
    pendingClarifies: new Map(),
    publish(ev: Published) { published.push(ev); },
    // 被测方法（从原型借——直接实例化 WxGateway 成本高，方法仅依赖自身状态与 publish）
    ...({} as Record<string, never>),
  } as any;
  return { gateway, published };
}

// 直接以最小宿主对象 + 借 WXGateway 原型方法（requestApproval/approvalRespond 等仅用 this.pendingApprovals/publish）
import { GatewayClient } from '../src/wxnodus-ui/wxGateway.js';

function borrow(names: string[]): any {
  const host: any = makeGateway().gateway;
  for (const n of names) host[n] = (GatewayClient.prototype as any)[n];
  return host;
}

describe('V4 P2-4 审批多路化', () => {
  it('并发双审批：各自独立可答，互不覆盖（旧单槽第二个请求覆盖第一个 → 永久挂起）', async () => {
    const host = borrow(['requestApproval', 'approvalRespond']);
    const p1 = host.requestApproval('bash', { command: 'rm a' });
    const p2 = host.requestApproval('fs_write', { path: 'x' });
    expect(host.pendingApprovals.size).toBe(2);
    // 各自的 request_id 独立应答
    const ev1 = host.__published?.() ?? null;
    // approvalRespond 按最近事件流模拟：直接取 Map 的两个 id
    const ids = [...host.pendingApprovals.keys()];
    host.approvalRespond({ request_id: ids[1], choice: 'allow' });
    host.approvalRespond({ request_id: ids[0], choice: 'deny' });
    expect(await p1).toBe('deny');
    expect(await p2).toBe('allow');
    expect(host.pendingApprovals.size).toBe(0);
  });

  it('审批超时 fail-closed：120s 无应答自动 deny（回合不悬挂）', async () => {
    vi.useFakeTimers();
    try {
      const host = borrow(['requestApproval', 'approvalRespond']);
      const p = host.requestApproval('bash', { command: 'x' });
      vi.advanceTimersByTimeAsync(120_001);
      expect(await p).toBe('deny');
      expect(host.pendingApprovals.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('clarify 多路 + 超时空串；clarify.respond 不再误答审批（死代码消除断言）', async () => {
    vi.useFakeTimers();
    try {
      const host = borrow(['requestApproval', 'approvalRespond', 'requestClarify', 'clarifyRespond']);
      const approval = host.requestApproval('bash', { command: 'danger' });
      const clar = host.requestClarify('选哪个？', ['a', 'b']);
      // 迟到的 clarify.respond（无匹配澄清 id）——审批必须不受影响
      host.clarifyRespond({ answer: '' });
      // 审批正常应答
      const ids = [...host.pendingApprovals.keys()];
      host.approvalRespond({ request_id: ids[0], choice: 'deny' });
      expect(await approval).toBe('deny');
      // 澄清按各自 id 应答
      const cids = [...host.pendingClarifies.keys()];
      host.clarifyRespond({ request_id: cids[0], answer: 'a' });
      expect(await clar).toBe('a');
      // 第二个澄清超时空串
      const clar2 = host.requestClarify('另一个问题');
      vi.advanceTimersByTimeAsync(60_001);
      expect(await clar2).toBe('');
    } finally { vi.useRealTimers(); }
  });

  it('cancelForeground 全清：审批 deny + 澄清空串（旧版漏清 pendingClarify）', async () => {
    const host = borrow(['requestApproval', 'requestClarify', 'cancelForeground']);
    host.running = true; // cancelForeground 前置（!running 直接 false）——foregroundRun 留空走全清路径
    const ap = host.requestApproval('bash', { command: 'x' });
    const cl = host.requestClarify('问题');
    expect(host.cancelForeground()).toBe(true);
    expect(await ap).toBe('deny');
    expect(await cl).toBe('');
    expect(host.pendingApprovals.size).toBe(0);
    expect(host.pendingClarifies.size).toBe(0);
  });
});

// V4 P2-5：error 作用域分流——rpc/transient 后台失败只记活动区（不动 busy/不进转写）
import { createGatewayEventHandler } from '../src/wxnodus-ui/bridge/eventAdapter.js';
import type { GatewayEventHandlerContext } from '../src/wxnodus-ui/bridge/interfaces.js';

describe('V4 P2-5 error 作用域化', () => {
  // turnController 为模块级单例（非 ctx 注入）——以 sys 转写行为为可观察面：
  // rpc/transient 分流提前 return（不进转写/不 sys）；core 走原路径（sys error 行）。
  const makeHandler = (calls: string[]) => {
    const ctx = {
      composer: { setInput: () => {} },
      gateway: { rpc: async () => null },
      session: { STARTUP_RESUME_ID: 'none', newSession: () => {}, resumeById: () => {}, setCatalog: () => {} },
      submission: { submitRef: { current: () => {} } },
      system: { bellOnComplete: false, sys: (t: string) => calls.push(`sys:${t}`) },
      transcript: { appendMessage: () => {}, panel: () => {}, setHistoryItems: () => {} },
      voice: { setProcessing: () => {}, setRecording: () => {}, setVoiceEnabled: () => {}, setVoiceTts: () => {} },
    };
    return createGatewayEventHandler(ctx as never);
  };

  it("scope='rpc'（后台 RPC 失败）：分流不进转写（无 sys error 行——错误刷屏根治）", () => {
    const calls: string[] = [];
    makeHandler(calls)({ type: 'error', payload: { message: 'session.list failed', scope: 'rpc' } } as any);
    expect(calls).toEqual([]); // 无 sys/无转写——agent 直播不被打断
  });

  it('scope 缺省（core，agent 回合错误）：原路径零回归（sys error 行可见）', () => {
    const calls: string[] = [];
    makeHandler(calls)({ type: 'error', payload: { message: '模型调用失败' } } as any);
    expect(calls.some(c => c.startsWith('sys:error:'))).toBe(true);
  });
});
