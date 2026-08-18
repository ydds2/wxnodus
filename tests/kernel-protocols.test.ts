// tests/kernel-protocols.test.ts — A2A/ACP 协议：本地环回端到端
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { a2aServe, a2aCall } from '../src/kernel/a2a.js';

const servers: Array<{ stop(): void }> = [];
afterEach(() => { for (const s of servers) s.stop(); });

describe('A2A 协议（本地环回）', () => {
  it('serve 启动端点 + call 环回调用（messages/send → agent 应答）', async () => {
    const s = await a2aServe(0, async (text) => ({ ok: true, text: `echo:${text}` }));
    servers.push(s);
    const r = await a2aCall(s.url, 'hello-a2a');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('echo:hello-a2a');
  });
  it('对端不可达返回明确错误', async () => {
    const r = await a2aCall('http://127.0.0.1:1/', 'x', { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('失败');
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

  it('session/load 全量：store 注入后 new 落库、load 校验存在性、真历史、cancel 诚实报错', () => {
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
    expect(cancel.error.code).toBe(-32601); // 诚实报错：宿主 agent 无 sid 级 abort
  });
});
