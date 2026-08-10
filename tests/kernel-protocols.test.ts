// tests/kernel-protocols.test.ts — A2A/ACP 协议：本地环回端到端
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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
    const script = `
      import { runAcpServer } from 'file:///C:/Users/20164/Desktop/WxNodusV3CLI/dist/kernel/acp.js';
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
});
