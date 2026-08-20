// tests/kernel-lsp-client.test.ts — LSP 集成（gap P2）：stdio JSON-RPC 客户端 + 服务器发现
// mock LSP 服务器为临时落盘的 Node 脚本（Content-Length 帧协议真实同构）——
// 覆盖：initialize/didOpen/pull 诊断/hover/definition/shutdown/close、
// pull 不支持时 publishDiagnostics 兜底、ENOENT 诚实报错带安装指引、发现与匹配纯函数
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LspSession, discoverLspServers, serverForFile, hoverToText, fileUri, uriToPath,
  resolveTypeScriptServer, closeAllLspSessions,
} from '../src/kernel/lspClient.js';

let dir: string;
let serverPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-lsp-'));
  serverPath = join(dir, 'mock-lsp-server.mjs');
  writeFileSync(serverPath, MOCK_SERVER, 'utf8');
  // 探测用假 node_modules/.bin（resolveTypeScriptServer 本地优先）
  writeFileSync(join(dir, 'probe.ts'), 'const x: number = "1";\n', 'utf8');
});
afterEach(async () => {
  await closeAllLspSessions();
  // mock 服务器子进程退出有延迟（句柄释放竞态）——重试删除防 EBUSY
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

const MOCK_SERVER = `import { writeFileSync } from 'node:fs';
process.stdout.on('error', () => {}); // 客户端关闭后写 EPIPE 防护
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const header = buf.slice(0, sep).toString('ascii');
    const m = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) return;
    const body = buf.slice(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.slice(sep + 4 + len);
    try { handle(JSON.parse(body)); } catch (e) { process.stderr.write(String(e)); }
  }
});
function send(obj) {
  try {
    const b = Buffer.from(JSON.stringify(obj), 'utf8');
    process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n');
    process.stdout.write(b);
  } catch (e) { /* EPIPE：客户端已关闭 */ }
}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
  if (msg.method === 'textDocument/diagnostic') {
    if (process.env.MOCK_NO_PULL === '1') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { kind: 'full', items: [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, severity: 1, message: 'mock error', code: 'MOCK1', source: 'mock' },
    ] } });
  }
  if (msg.method === 'textDocument/didOpen') {
    return send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: msg.params.textDocument.uri,
      diagnostics: [
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, severity: 2, message: 'published warning' },
      ],
    } });
  }
  if (msg.method === 'textDocument/hover') return send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: '**mock hover**' } } });
  if (msg.method === 'textDocument/definition') return send({ jsonrpc: '2.0', id: msg.id, result: { uri: msg.params.textDocument.uri, range: { start: { line: 4, character: 5 }, end: { line: 4, character: 9 } } } });
  if (msg.method === 'shutdown') return send({ jsonrpc: '2.0', id: msg.id, result: null });
  if (msg.method === 'exit') process.exit(0);
  send({ jsonrpc: '2.0', id: msg.id, result: null });
}
`;

const spec = () => ({ id: 'mock', command: process.execPath, args: [serverPath], languages: ['typescript', 'python'] });

describe('LspSession（mock 服务器同构）', () => {
  it('initialize → 拉取诊断（severity 映射 1-based 行列）', async () => {
    const s = await LspSession.start(spec(), dir);
    const diags = await s.diagnostics(join(dir, 'probe.ts'), 'x');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ line: 2, col: 1, severity: 'error', message: 'mock error', code: 'MOCK1', source: 'mock' });
    await s.close();
  });

  it('hover / definition（1-based 输入 → 0-based LSP 位置）', async () => {
    const s = await LspSession.start(spec(), dir);
    expect(await s.hover(join(dir, 'probe.ts'), 1, 1)).toContain('mock hover');
    expect(await s.definition(join(dir, 'probe.ts'), 2, 3)).toContain('probe.ts:5:6');
    await s.close();
  });

  it('pull 不支持（-32601）→ publishDiagnostics 通知兜底', async () => {
    process.env.MOCK_NO_PULL = '1';
    try {
      const s = await LspSession.start(spec(), dir);
      const diags = await s.diagnostics(join(dir, 'probe.ts'), 'x');
      expect(diags).toHaveLength(1);
      expect(diags[0]!.severity).toBe('warning');
      expect(diags[0]!.message).toBe('published warning');
      await s.close();
    } finally {
      delete process.env.MOCK_NO_PULL;
    }
  }, 15_000);

  it('close 后请求拒绝（不泄漏会话）', async () => {
    const s = await LspSession.start(spec(), dir);
    await s.close();
    await expect(s.hover(join(dir, 'probe.ts'), 1, 1)).rejects.toThrow();
  });

  it('ENOENT 服务器 → 诚实报错带安装指引（绝不假装诊断）', async () => {
    await expect(LspSession.start({ id: 'x', command: 'wxnodus-no-such-lsp-server-xyz', args: [] }, dir))
      .rejects.toThrow(/未找到语言服务器|启动失败/);
  });
});

describe('服务器发现与匹配（纯函数）', () => {
  it('discoverLspServers：settings.lsp.servers + 内置 typescript 探测项', () => {
    const list = discoverLspServers({ lsp: { servers: [{ id: 'py', command: 'pylsp', languages: ['python'] }] } }, dir);
    expect(list.some(s => s.id === 'py' && s.command === 'pylsp')).toBe(true);
    expect(list.some(s => s.id === 'typescript')).toBe(true); // 内置默认（命令存在性由 spawn 诚实判定）
  });

  it('serverForFile：按扩展名语言匹配 + pattern 匹配', () => {
    const specs = [
      { id: 'py', command: 'pylsp', languages: ['python'] },
      { id: 'glob', command: 'x', pattern: '*.md' },
    ];
    expect(serverForFile(specs, 'a.py')?.id).toBe('py');
    expect(serverForFile(specs, 'notes.md')?.id).toBe('glob');
    expect(serverForFile(specs, 'x.cpp')).toBeNull();
  });

  it('resolveTypeScriptServer：cwd/node_modules/.bin 优先', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'wxn-lsp-ts-'));
    mkdirSync(join(dir2, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir2, 'node_modules', '.bin', 'typescript-language-server.cmd'), '');
    expect(resolveTypeScriptServer(dir2)).toContain('typescript-language-server');
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe('纯工具函数', () => {
  it('hoverToText：string/MarkupContent/数组归一', () => {
    expect(hoverToText(undefined)).toContain('无悬停信息');
    expect(hoverToText({ contents: 'plain' })).toBe('plain');
    expect(hoverToText({ contents: { value: '**md**' } })).toBe('**md**');
    expect(hoverToText({ contents: ['a', { value: 'b' }] })).toBe('a\nb');
  });
  it('fileUri/uriToPath 互逆', () => {
    expect(uriToPath(fileUri('C:/x/y.ts')).replace(/\\/g, '/').toLowerCase()).toBe('c:/x/y.ts');
  });
});
