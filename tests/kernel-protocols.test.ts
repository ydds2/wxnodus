// tests/kernel-protocols.test.ts — A2A/ACP 协议：本地环回端到端
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { a2aServe, a2aCall, a2aTaskSend, a2aStdioServe, buildAgentCard, fetchAgentCard } from '../src/kernel/a2a.js';

const servers: Array<{ stop(): Promise<void> | void }> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.stop())); });

describe('A2A 协议（本地环回）', () => {
  it('serve 启动端点 + call 环回调用（messages/send → agent 应答）', async () => {
    const s = await a2aServe(0, async (text) => ({ ok: true, text: `echo:${text}` }));
    servers.push(s);
    const r = await a2aCall(s.url, 'hello-a2a', { token: s.token });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('echo:hello-a2a');
  });
  it('对端不可达返回明确错误', async () => {
    const r = await a2aCall('http://127.0.0.1:1/', 'x', { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('失败');
  });

  it('messages/send 客户端断开时取消执行且不重复取消', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>(resolve => { resolveCancelled = resolve; });
    let cancelCount = 0;
    const s = await a2aServe(0, () => {
      let finish!: (result: { ok: boolean; text: string; status: 'cancelled' }) => void;
      const completion = new Promise<{ ok: boolean; text: string; status: 'cancelled' }>(resolve => { finish = resolve; });
      resolveStarted();
      return {
        completion,
        cancel: () => {
          cancelCount += 1;
          finish({ ok: false, text: '', status: 'cancelled' });
          resolveCancelled();
        },
      };
    });
    servers.push(s);

    const controller = new AbortController();
    const request = fetch(s.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'messages/send', params: { message: { role: 'user', parts: [{ text: 'disconnect' }] } } }),
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(request).rejects.toThrow();
    await expect(Promise.race([
      cancelled,
      new Promise((_, reject) => setTimeout(() => reject(new Error('message execution was not cancelled')), 1_000)),
    ])).resolves.toBeUndefined();
    await s.stop();
    expect(cancelCount).toBe(1);
  });

  it('stop 关闭接纳并取消、排空所有 messages/send 与 task 执行', async () => {
    const started: string[] = [];
    const cancelCounts = new Map<string, number>();
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>(resolve => { releaseCancellation = resolve; });
    const s = await a2aServe(0, (text) => {
      started.push(text);
      let finish!: (result: { ok: boolean; text: string; status: 'cancelled' }) => void;
      return {
        completion: new Promise(resolve => { finish = resolve; }),
        cancel: () => {
          cancelCounts.set(text, (cancelCounts.get(text) ?? 0) + 1);
          void cancellationGate.then(() => finish({ ok: false, text: '', status: 'cancelled' }));
        },
      };
    });
    servers.push(s);

    const message = (text: string, id: number) => fetch(s.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'messages/send', params: { message: { role: 'user', parts: [{ text }] } } }),
    }).catch(() => undefined);
    const first = message('message-one', 1);
    const second = message('message-two', 2);
    const taskResponse = await fetch(s.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tasks/send', params: { message: { role: 'user', parts: [{ text: 'task-one' }] } } }),
    });
    await taskResponse.json();
    while (started.length < 3) await new Promise(resolve => setTimeout(resolve, 5));

    let stopped = false;
    const stopping = s.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(stopped).toBe(false);
    expect(Object.fromEntries(cancelCounts)).toEqual({
      'message-one': 1,
      'message-two': 1,
      'task-one': 1,
    });
    await expect(fetch(s.url, { signal: AbortSignal.timeout(500) })).rejects.toThrow();

    releaseCancellation();
    await stopping;
    await Promise.all([first, second]);
    expect(stopped).toBe(true);
    expect(Object.fromEntries(cancelCounts)).toEqual({
      'message-one': 1,
      'message-two': 1,
      'task-one': 1,
    });
  });
});

describe('ACP 协议（stdio 管道）', () => {
  it('initialize + session/new 握手响应', () => {
    // 动态计算 dist 路径（禁止硬编码开发机绝对路径——CI 首轮实测暴露 file:///C:/Users/20164 泄漏）
    const acpUrl = pathToFileURL(join(process.cwd(), 'dist', 'kernel', 'acp.js')).href;
    const script = `
      import { runAcpServer } from '${acpUrl}';
      runAcpServer({ run: async (t) => ({ ok: true, text: 'acp:' + t }) });
    `;
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'prompt', params: { sessionId: 's1', content: '你好' } },
    ].map(j => JSON.stringify(j)).join('\n') + '\n';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input, encoding: 'utf8', timeout: 20000 });
    const lines = (r.stdout ?? '').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    const init = JSON.parse(lines[0]!);
    expect(init.id).toBe(1);
    expect(init.result.protocolVersion).toBe(1);
    const session = JSON.parse(lines[1]!);
    expect(session.result.session.id).toContain('acp-');
    const prompt = JSON.parse(lines[2]!);
    expect(prompt.result.message.content).toBe('acp:你好');
  });

  it('session/load 全量：store 注入后 new 落库、load 校验存在性、真历史、cancel 可用', () => {
    const acpUrl = pathToFileURL(join(process.cwd(), 'dist', 'kernel', 'acp.js')).href;
    const script = `
      import { runAcpServer } from '${acpUrl}';
      runAcpServer({
        run: async (t) => ({ ok: true, text: 'acp:' + t }),
        store: {
          createSession: () => 's-persist',
          sessionExists: (id) => id === 's-real',
          loadHistory: (id) => id === 's-real' ? [{ role: 'user', content: '旧消息' }] : [],
        },
      });
    `;
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: 's-real' } },
      { jsonrpc: '2.0', id: 4, method: 'session/load', params: { sessionId: 's-missing' } },
      { jsonrpc: '2.0', id: 5, method: 'session/load_history', params: { sessionId: 's-real' } },
      { jsonrpc: '2.0', id: 6, method: 'session/update', params: { sessionId: 's-real', model: 'deepseek' } },
      { jsonrpc: '2.0', id: 7, method: 'session/cancel', params: { sessionId: 's-real' } },
    ].map(j => JSON.stringify(j)).join('\n') + '\n';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input, encoding: 'utf8', timeout: 20000 });
    const lines = (r.stdout ?? '').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(7);
    const init = JSON.parse(lines[0]!);
    expect(init.result.capabilities.loadSession).toBe(true); // store 注入 → 能力位宣告
    const created = JSON.parse(lines[1]!);
    expect(created.result.session.id).toBe('s-persist');
    const loaded = JSON.parse(lines[2]!);
    expect(loaded.result.session.id).toBe('s-real');
    const missing = JSON.parse(lines[3]!);
    expect(missing.error.code).toBe(-32602);
    expect(missing.error.message).toContain('s-missing');
    const hist = JSON.parse(lines[4]!);
    expect(hist.result.history).toEqual([{ role: 'user', content: '旧消息' }]);
    const upd = JSON.parse(lines[5]!);
    expect(upd.result).toEqual({});
    const cancel = JSON.parse(lines[6]!);
    expect(cancel.result).toEqual({ cancelled: 0 });
  });

  it('session/cancel 精确取消同 session 的活动 prompt', () => {
    const acpUrl = pathToFileURL(join(process.cwd(), 'dist', 'kernel', 'acp.js')).href;
    const script = `
      import { runAcpServer } from '${acpUrl}';
      let cancelled = 0;
      runAcpServer({
        run: () => {
          let finish;
          const completion = new Promise(resolve => { finish = resolve; });
          return {
            completion,
            cancel: () => {
              cancelled += 1;
              finish({ ok: false, text: '', status: 'cancelled', error: 'cancelled by client' });
            },
          };
        },
      }).then(() => {
        process.stderr.write('cancelled=' + cancelled);
      });
    `;
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'prompt', params: { sessionId: 's-active', content: '等待' } },
      { jsonrpc: '2.0', id: 2, method: 'session/cancel', params: { sessionId: 's-active' } },
    ].map(j => JSON.stringify(j)).join('\n') + '\n';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input, encoding: 'utf8', timeout: 20_000 });
    const frames = (r.stdout ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const byId = new Map(frames.map(frame => [frame.id, frame]));
    expect(byId.get(2)?.result).toEqual({ cancelled: 1 });
    expect(byId.get(1)?.error).toEqual({ code: -32800, message: 'cancelled by client' });
    expect(r.stderr).toContain('cancelled=1');
  });
});

describe('A2A 完整版（agent card / 任务流 / cancel / push / stdio）', () => {
  it('buildAgentCard：协议版本/能力/skills 声明', () => {
    const card = buildAgentCard({ name: 'wxnodus', description: '本地 AI 编码 CLI', skills: [{ name: 'code-review', description: '审查代码' }], pushNotifications: true });
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(card.skills).toEqual([{ name: 'code-review', description: '审查代码' }]);
  });

  it('serve 暴露 /.well-known/agent.json 卡片 + fetchAgentCard 解析', async () => {
    const s = await a2aServe(0, async t => ({ ok: true, text: 'echo:' + t }), { card: { name: 'wx-test', description: 'd', skills: [{ name: 's1' }] } });
    servers.push(s);
    const card = await fetchAgentCard(s.url);
    expect(card.ok).toBe(true);
    expect(card.card?.name).toBe('wx-test');
    expect(card.card?.skills).toEqual([{ name: 's1' }]);
    expect(card.card?.url).toBe(s.url);
  });

  it('tasks/send → 轮询至 completed（artifact 回声）', async () => {
    const s = await a2aServe(0, async t => ({ ok: true, text: 'echo:' + t }));
    servers.push(s);
    const r = await a2aTaskSend(s.url, 'hello-task', { timeoutMs: 15000, token: s.token });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('completed');
    expect(r.text).toBe('echo:hello-task');
    expect(r.taskId.length).toBeGreaterThan(0);
  });

  it('tasks/get 未知任务 → -32602 诚实错误', async () => {
    const s = await a2aServe(0, async t => ({ ok: true, text: t }));
    servers.push(s);
    const resp = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tasks/get', params: { id: 't-nope' } }) });
    const j = await resp.json() as any;
    expect(j.error.code).toBe(-32602);
  });

  it('tasks/cancel：working 任务 → canceled，并取消匹配的执行句柄', async () => {
    let release!: (value: { ok: boolean; text: string; status: 'cancelled' }) => void;
    const completion = new Promise<{ ok: boolean; text: string; status: 'cancelled' }>(res => { release = res; });
    let cancelCount = 0;
    const s = await a2aServe(0, () => ({
      completion,
      cancel: () => {
        cancelCount += 1;
        release({ ok: false, text: '', status: 'cancelled' });
      },
    }));
    servers.push(s);
    const send = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { message: { role: 'user', parts: [{ text: 'block' }] } } }) });
    const task = ((await send.json()) as any).result;
    const cancel = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: task.id } }) });
    const cj = (await cancel.json()) as any;
    expect(cj.result.state).toBe('canceled');
    expect(cancelCount).toBe(1);
  });

  it('tasks/send：非成功 Run 映射 failed，不产生完成产物', async () => {
    const sessions: string[] = [];
    const s = await a2aServe(0, async (_text, request) => {
      sessions.push(request.sessionId);
      return { ok: false, text: '', status: 'blocked', error: 'policy denied' };
    });
    servers.push(s);
    const r = await a2aTaskSend(s.url, 'blocked', { timeoutMs: 15_000, token: s.token });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('failed');
    expect(r.error).toBe('policy denied');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/^a2a-task-/);
  });

  it('push 通知：pushNotificationConfig 注册 → 状态变更 POST 到回调', async () => {
    const received: any[] = [];
    const recv = createServer((req, res) => {
      let b = ''; req.on('data', c => { b += c; });
      req.on('end', () => { received.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('{}'); });
    });
    await new Promise<void>(res => recv.listen(0, '127.0.0.1', res));
    const recvUrl = `http://127.0.0.1:${(recv.address() as any).port}/hook`;
    const s = await a2aServe(0, async t => ({ ok: true, text: 'p:' + t }));
    servers.push(s);
    const resp = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tasks/send', params: { message: { role: 'user', parts: [{ text: 'hi' }] }, pushNotificationConfig: { url: recvUrl } } }) });
    const j = (await resp.json()) as any;
    expect(j.result.id).toBeTruthy();
    await new Promise(res => setTimeout(res, 400));
    expect(received.length).toBeGreaterThan(0);
    expect(JSON.stringify(received)).toContain(j.result.id);
    recv.close();
  });

  it('stdio 传输：initialize + tasks/send 行协议（子进程，dist 构建产物）', () => {
    const a2aUrl = pathToFileURL(join(process.cwd(), 'dist', 'kernel', 'a2a.js')).href;
    const script = `
      import { a2aStdioServe } from '${a2aUrl}';
      a2aStdioServe({ run: async (t) => ({ ok: true, text: 'std:' + t }) });
    `;
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tasks/send', params: { message: { role: 'user', parts: [{ text: 'x' }] } } },
    ].map(j => JSON.stringify(j)).join('\n') + '\n';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input, encoding: 'utf8', timeout: 20000 });
    const lines = (r.stdout ?? '').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const init = JSON.parse(lines[0]!);
    expect(init.result.protocolVersion).toBe('0.3.0');
    const send = JSON.parse(lines[1]!);
    expect(send.result.id).toContain('t-');
  });
});

// V4 P0-7：a2a 端点认证门——无 token 401 / 非 JSON Content-Type 415 / agent.json 卡片保持公开。
describe('V4 P0-7 a2a 认证门', () => {
  it('无 Bearer → 401；text/plain（CORS simple request 形态）→ 415；带 token 正常', async () => {
    const s = await a2aServe(0, async t => ({ ok: true, text: `echo:${t}` }));
    try {
      // 无认证
      const noAuth = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'messages/send', params: { message: { role: 'user', parts: [{ text: 'x' }] } } }) });
      expect(noAuth.status).toBe(401);
      // text/plain（恶意网页跨站 simple request 形态——无预检即可发送）
      const plain = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
      expect(plain.status).toBe(415);
      // agent.json 发现性卡片保持公开（零敏感）
      const card = await fetch(`${s.url.replace(/\/$/, '')}/.well-known/agent.json`);
      expect(card.status).toBe(200);
      // 错 token 401
      const bad = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'messages/send', params: { message: { role: 'user', parts: [{ text: 'x' }] } } }) });
      expect(bad.status).toBe(401);
      // 正确 token 正常
      const ok = await a2aCall(s.url, 'hi', { token: s.token });
      expect(ok.ok).toBe(true);
    } finally {
      await s.stop();
    }
  });
});
