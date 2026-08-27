// tests/cli-wire-alias.test.ts — --stream-json 是 --wire 事件流的命名别名（gemini/kimi 对齐）
// 契约：别名解析并入 wire（args.ts 单一事实源）——真实进程 stdout 全程 JSONL、以 agent.result 终态收尾、
//       wire 下 stdin 为帧通道而非管道素材（与 cli-stdin-pipe 的护栏互斥验证）。
// dist 未构建时诚实 skip。
// P1-6（2026-08-27）flaky 根治：模型调用改本地 mock OpenAI 兼容服务器（经 WXNODUS_BASE_URL/
// WXNODUS_API_KEY 注入）——此前真实模型调用在全量并发下抖动/超时（网络类 flaky 结构性消除）。
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(__dirname, '../dist/cli/index.js');
const hasDist = existsSync(CLI);

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });

let mockServer: Server;
let mockBase: string;
beforeAll(async () => {
  // 本地 mock OpenAI 兼容服务器：任何模型任何请求 → 固定 SSE 流（内容 + usage + [DONE]）
  mockServer = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"m1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"你好，我是本地 mock 模型"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"m1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"。任务已完成"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":8}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>(r => mockServer.listen(0, '127.0.0.1', () => r()));
  mockBase = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}/v1`;
});
afterAll(() => { mockServer?.close(); });

const runWire = (args: string[]): Promise<{ code: number | null; lines: any[] }> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wxn-wire-'));
  tempDirs.push(dataDir);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, '--data-dir', dataDir, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      // P1-6：模型端点注入本地 mock——无真实网络、无密钥、全量并发下确定性
      env: { ...process.env, WXNODUS_BASE_URL: mockBase, WXNODUS_API_KEY: 'mock-key' },
    });
    let buf = '';
    const lines: any[] = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 静默 */ } reject(new Error('wire CLI timeout')); }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: Buffer) => {
      buf += String(c);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        lines.push((() => { try { return JSON.parse(line); } catch { return { raw: line }; } })());
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, lines }); });
    child.stdin.end();
  });
};

const describeWithDist = hasDist ? describe : describe.skip;

describeWithDist('--stream-json 别名（= --wire 事件流）', () => {
  it('stdout 全程 JSONL：agent.start 起、agent.result 终，退出码 0', async () => {
    const r = await runWire(['-p', '你好', '--stream-json']);
    expect(r.code).toBe(0);
    expect(r.lines.length).toBeGreaterThan(0);
    for (const l of r.lines) expect(l).not.toHaveProperty('raw'); // 无任何非 JSON 行
    expect(r.lines[0].type).toBe('agent.start');
    const last = r.lines[r.lines.length - 1];
    expect(last.type).toBe('agent.result');
    expect(['succeeded', 'failed', 'blocked', 'incomplete', 'inconclusive', 'cancelled']).toContain(last.wireFinal);
  }, 90_000);

  it('与 --wire 同构（事件类型集合一致）', async () => {
    const a = await runWire(['-p', '你好', '--wire']);
    const b = await runWire(['-p', '你好', '--stream-json']);
    const typesA = new Set(a.lines.map(l => l.type));
    const typesB = new Set(b.lines.map(l => l.type));
    expect(typesB).toEqual(typesA);
    expect(typesA.has('agent.start')).toBe(true);
    expect(typesA.has('agent.result')).toBe(true);
  }, 90_000);
});
