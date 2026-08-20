// tests/cli-headless-wire-requests.test.ts — supremacy 2.1 前置修复：wire 请求广播（审批/澄清/密码/表单）
// 覆盖：四种 pending 请求都广播 request_id 事件；approval.respond/clarify.respond 凭 request_id
// 真实 resolve（此前 id 只存内存，前端无从应答）；未知 request_id 诚实 false；abort 释放 pending
import { describe, it, expect } from 'vitest';
import { createHeadlessWireGateway } from '../src/cli/headlessGateway.js';

describe('headless wire gateway：请求广播 + 应答闭环（supremacy 2.1）', () => {
  it('approval：广播 approval.request（含 request_id/tool/args）→ approval.respond 凭 id 放行', async () => {
    const events: Array<Record<string, unknown>> = [];
    const g = createHeadlessWireGateway({
      sessionId: 's1',
      onRequest: (ev) => events.push(ev),
    });
    const p = g.requestApproval('bash', { command: 'git push' });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('approval.request');
    const id = events[0]!.request_id as string;
    expect(id.length).toBeGreaterThan(10);
    expect(events[0]!.tool).toBe('bash');
    await g.handleFrame({ method: 'approval.respond', params: { request_id: id, answer: 'allow' } });
    expect(await p).toBe('allow');
  });

  it('clarify/secret/form：各自广播对应事件并凭 request_id 应答', async () => {
    const events: Array<Record<string, unknown>> = [];
    const g = createHeadlessWireGateway({ sessionId: 's2', onRequest: (ev) => events.push(ev) });
    const cp = g.requestClarify('选哪个方案？', ['A', 'B']);
    const sp = g.requestSecretInput('sudo', '需要密码', 'root');
    const fp = g.requestCredentialForm([{ name: 'token', kind: 'password' }], '录入凭据');
    expect(events.map(e => e.type)).toEqual(['clarify.request', 'secret.request', 'form.request']);
    const [c, s, f] = events as Array<Record<string, any>>;
    expect(c.question).toContain('方案');
    expect(s.kind).toBe('sudo');
    expect(f.fields).toHaveLength(1);
    await g.handleFrame({ method: 'clarify.respond', params: { request_id: c.request_id, answer: 'A' } });
    await g.handleFrame({ method: 'secret.respond', params: { request_id: s.request_id, value: 'pwd' } });
    await g.handleFrame({ method: 'credential_form.respond', params: { request_id: f.request_id, value: { token: 'x' } } });
    expect(await cp).toBe('A');
    expect(await sp).toBe('pwd');
    expect(await fp).toEqual({ token: 'x' });
  });

  it('未知 request_id 应答：handled=false（不误放行，pending 保持挂起）', async () => {
    const g = createHeadlessWireGateway({ sessionId: 's3' });
    const p = g.requestApproval('bash', {});
    const r = await g.handleFrame({ method: 'approval.respond', params: { request_id: 'nope', answer: 'allow' } });
    expect((r as any)?.value?.handled).toBe(false);
    g.abortPending(); // 未应答的 pending 释放（deny——fail-closed）
    expect(await p).toBe('deny');
  });

  it('不注入 onRequest：默认静默（兼容旧调用方，零漂移）', async () => {
    const g = createHeadlessWireGateway({ sessionId: 's4' });
    const p = g.requestApproval('bash', {});
    g.abortPending();
    expect(await p).toBe('deny');
  });
});
