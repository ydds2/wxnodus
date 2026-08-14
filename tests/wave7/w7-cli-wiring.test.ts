// tests/wave7/w7-cli-wiring.test.ts — W7-00/01/03 命令层接线（真实 CommandBus + 真实 SQLite + 真实 localhost 下载）
// 覆盖：/workspace show/set/reset（getter 即时生效）；/download 真实下载落盘 + sha256 证据；
// /assimilate --code 真实目录同化 + /hole --code 来源标注检索（FTS5 + bigram_zh）。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCommandBus } from '../../src/app/CommandBus.js';
import { registerCoreHandlers } from '../../src/commands/handlers.js';
import { registerExtHandlers } from '../../src/commands/handlersExt.js';
import { openDB, closeDB } from '../../src/store/db.js';
import { createEventBus } from '../../src/kernel/events.js';
import { createMemory } from '../../src/kernel/memory.js';
import { CodeIndexRepository } from '../../src/infrastructure/code/codeIndexRepository.js';
import { downloadFile, writeDownloadEvidence } from '../../src/application/download/downloadService.js';
import { checkUrlSafety } from '../../src/kernel/ssrf.js';
import { Readable } from 'node:stream';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w7-cli-')); tempDirs.push(d); return d; };

function makeCtx(dataDir: string, cwd: string, opts: { allowLoopback?: boolean } = {}) {
  const db = openDB(dataDir);
  const codeIndex = new CodeIndexRepository(db);
  codeIndex.install();
  let liveRoot = cwd;
  let liveSource = 'cwd';
  const ctx = {
    dataDir, cwd, db, mem: createMemory(db), bus: createEventBus(dataDir),
    config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined },
    agent: { getSessionId: () => 'smoke' },
    get workspaceRoot() { return liveRoot; },
    get workspaceSource() { return liveSource; },
    setWorkspace: (dir: string | null) => { liveRoot = dir ?? cwd; liveSource = dir ? 'persisted' : 'cwd'; },
    codeIndex,
    download: async (url: string, destDir: string, fileName?: string) => downloadFile(
      { url, workspaceRoot: liveRoot, destDir, fileName },
      {
        authorizeUrl: opts.allowLoopback
          ? async () => ({ ok: true as const })
          : checkUrlSafety,
        fetchOnce: async (target) => {
          const { fetch } = await import('undici');
          const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
          return {
            status: res.status,
            headers: Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k, String(v)])),
            body: Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
          };
        },
        evidence: (bundle) => { try { writeDownloadEvidence(dataDir, bundle); } catch { /* 证据失败不阻断 */ } },
      },
    ),
  };
  const bus = createCommandBus();
  registerCoreHandlers(bus, ctx as never);
  registerExtHandlers(bus, ctx as never);
  return { db, bus, ctx };
}

describe('W7 命令层接线', () => {
  it('/workspace show/set/reset 经 getter 即时生效', async () => {
    const dataDir = tmp();
    const cwd = tmp();
    const { db, bus } = makeCtx(dataDir, cwd);
    try {
      const shown = await bus.execute('/workspace');
      expect(shown.ok).toBe(true);
      expect(String(shown.output)).toContain(cwd);
      const setDir = tmp();
      const set = await bus.execute(`/workspace set ${setDir}`);
      expect(String(set.output)).toContain('已设置');
      const after = await bus.execute('/workspace');
      expect(String(after.output)).toContain(setDir);
      const reset = await bus.execute('/workspace reset');
      expect(String(reset.output)).toContain('已重置');
      const back = await bus.execute('/workspace');
      expect(String(back.output)).toContain(cwd);
    } finally { closeDB(db); }
  });

  it('/download 命令路径：真实 SSRF 策略诚实拒绝回环地址', async () => {
    const dataDir = tmp();
    const cwd = tmp();
    const { db, bus } = makeCtx(dataDir, cwd);
    try {
      const r = await bus.execute('/download http://127.0.0.1:1/x.bin');
      expect(r.ok).toBe(true); // 命令正常返回（非崩溃）
      expect(String(r.output)).toContain('下载失败：DOWNLOAD_URL_BLOCKED');
    } finally { closeDB(db); }
  });

  it('/download 真实下载 → 工作区落盘 + 证据文件（生产 undici 流 + 证据落盘）', async () => {
    const payload = Buffer.from('wxnodus download smoke', 'utf8');
    const server: Server = await new Promise((resolveServer) => {
      const s = createServer((_req, res) => { res.writeHead(200, { 'content-length': String(payload.length) }); res.end(payload); });
      s.listen(0, '127.0.0.1', () => resolveServer(s));
    });
    const port = (server.address() as AddressInfo).port;
    const dataDir = tmp();
    const cwd = tmp();
    const { db, bus } = makeCtx(dataDir, cwd, { allowLoopback: true });
    try {
      const r = await bus.execute(`/download http://127.0.0.1:${port}/smoke.bin`);
      expect(r.ok).toBe(true);
      const out = String(r.output);
      expect(out).toContain('已下载');
      expect(out).toContain('sha256=');
      const files = readdirSync(join(cwd, 'downloads'));
      expect(files).toContain('smoke.bin');
      const evidence = readdirSync(join(dataDir, 'evidence', 'downloads'));
      expect(evidence.length).toBe(1);
    } finally { server.close(); closeDB(db); }
  });

  it('/assimilate --code 真实目录 → /hole --code 命中（来源标注 [代码]）', async () => {
    const dataDir = tmp();
    const cwd = tmp();
    const src = tmp();
    mkdirSync(join(src, 'lib'), { recursive: true });
    writeFileSync(join(src, 'lib', 'engine.ts'), '// 黑洞调度引擎\nexport function scheduleBlackholeJob() {}\n', 'utf8');
    const { db, bus } = makeCtx(dataDir, cwd);
    try {
      const a = await bus.execute(`/assimilate --code ${src}`);
      const aOut = String(a.output);
      expect(aOut).toContain('索引 1 个');
      const h = await bus.execute('/hole --code 黑洞调度');
      const hOut = String(h.output);
      expect(hOut).toContain('[代码]');
      expect(hOut).toContain('engine.ts');
      const miss = await bus.execute('/hole --code 不存在的符号xyz');
      expect(String(miss.output)).toContain('未检索到');
    } finally { closeDB(db); }
  });

  it('/assimilate --plugins + --mcp → /hole --code 来源标注 [插件]/[MCP]', async () => {
    const dataDir = tmp();
    const cwd = tmp();
    mkdirSync(join(dataDir, 'plugins', 'auto-deploy'), { recursive: true });
    writeFileSync(join(dataDir, 'plugins', 'auto-deploy', 'plugin.json'), JSON.stringify({ name: 'auto-deploy', description: '自动部署工作流' }));
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { filesystem: { command: 'npx', description: '文件系统操作' } } }));
    const { db, bus } = makeCtx(dataDir, cwd);
    try {
      expect(String((await bus.execute('/assimilate --plugins')).output)).toContain('索引 1 个');
      expect(String((await bus.execute('/assimilate --mcp')).output)).toContain('索引 1 个');
      const h = await bus.execute('/hole --code 部署');
      expect(String(h.output)).toContain('[插件]');
      const h2 = await bus.execute('/hole --code 文件系统');
      expect(String(h2.output)).toContain('[MCP]');
    } finally { closeDB(db); }
  });
});
