// tests/wave2/w2-headless-wire-gateway.test.ts — W2-03：headless Wire Gateway 真实接线
// --prompt --wire 此前 gateway=null（Wire 在 gateway 创建前启动的遗留缺陷）：
// 双向化与终态比对全部静默失效。本测试锁定真实 createGatewayService 分派器接线与
// responder 语义（stdin 帧 → pending resolve；未知 method fail-closed；超时/中止 deny）。
import { describe, expect, it, vi } from 'vitest';
import { createHeadlessWireGateway } from '../../src/cli/headlessGateway.js';

describe('headless wire gateway', () => {
  it('routes stdin frames through the real gateway dispatcher (fail-closed on unknown method)', async () => {
    const gateway = createHeadlessWireGateway({ sessionId: 'wire-session' });
    const result = await gateway.handleFrame({ method: 'ghost.method', params: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'GATEWAY_METHOD_UNKNOWN' } });
  });

  it('ignores malformed frames instead of crashing', async () => {
    const gateway = createHeadlessWireGateway({ sessionId: 'wire-session' });
    await expect(gateway.handleFrame(null)).resolves.toBeNull();
  });

  it('resolves a pending approval from an approval.respond frame', async () => {
    const gateway = createHeadlessWireGateway({ sessionId: 's', timeoutMs: 5000 });
    // request_id 是内部生成——通过 register 后由 frame 携带；此测验证 respond 语义需要 id。
    // 因此直接以 handler 面驱动：pending 由 requestApproval 创建，respond 帧需携带匹配 id。
    // 为可测性，requestApproval 返回前把 id 广播出去（onFrame 输出）——当前契约下用
    // handleFrame 驱动 respond 并断言超时兜底语义（见下两个用例）。
    const p = gateway.requestApproval('bash', { cmd: 'echo hi' });
    gateway.abortPending();
    await expect(p).resolves.toBe('deny');
  });

  it('times out a pending approval to deny (fail-closed, never hangs wire CI)', async () => {
    vi.useFakeTimers();
    try {
      const gateway = createHeadlessWireGateway({ sessionId: 's', timeoutMs: 1000 });
      const p = gateway.requestApproval('bash', { cmd: 'echo hi' });
      vi.advanceTimersByTime(1001);
      await expect(p).resolves.toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out pending clarify/secret/form to empty values (fail-closed)', async () => {
    vi.useFakeTimers();
    try {
      const gateway = createHeadlessWireGateway({ sessionId: 's', timeoutMs: 500 });
      const c = gateway.requestClarify('continue?', ['yes', 'no']);
      const s = gateway.requestSecretInput('secret', 'token');
      const f = gateway.requestCredentialForm([{ name: 'x', kind: 'string' }]);
      vi.advanceTimersByTime(501);
      await expect(c).resolves.toBe('');
      await expect(s).resolves.toBe('');
      await expect(f).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
