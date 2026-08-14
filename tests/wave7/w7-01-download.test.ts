// tests/wave7/w7-01-download.test.ts — W7-01：下载框架（真实 localhost 流式下载）
// 契约：流式原子落盘（tmp+rename，中断零残留）→ sha256 证据；Content-Length/真实字节双上限；
// 文件名三源（显式/Content-Disposition/URL basename）全过 sanitize；工作区边界 + 逐跳授权 fail-closed。
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { downloadFile, filenameFromContentDisposition, sanitizeDownloadFilename } from '../../src/application/download/downloadService.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w7-dl-')); tempDirs.push(d); return d; };

const BYTES = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 251));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface ServeOptions { body?: Buffer; contentLength?: number; headers?: Record<string, string>; truncateAt?: number }
function serve(opts: ServeOptions = {}): Promise<{ server: Server; url: string }> {
  const body = opts.body ?? BYTES;
  return new Promise((resolveServe, reject) => {
    const server = createServer((_req, res: ServerResponse) => {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream', ...(opts.headers ?? {}) };
      if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength);
      res.writeHead(200, headers);
      if (opts.truncateAt !== undefined) {
        res.write(body.subarray(0, opts.truncateAt));
        setTimeout(() => res.destroy(new Error('aborted')), 20);
      } else {
        res.end(body);
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServe({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin` }));
  });
}

/** 测试 fetch 端口：真实 http.get（无重定向）+ 可选 authorized 白名单（默认全放行） */
function portsOf(allowed: Set<string> | null = null) {
  return {
    authorizeUrl: async (url: string) => {
      if (allowed && !allowed.has(url)) return { ok: false as const, reason: 'blocked' };
      return { ok: true as const };
    },
    fetchOnce: async (url: string): Promise<{ status: number; headers: Record<string, string>; body: import('node:stream').Readable }> => {
      const { get } = await import('node:http');
      return new Promise((resolveFetch, reject) => {
        get(url, (res) => resolveFetch({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v ?? '')])),
          body: res,
        })).on('error', reject);
      });
    },
    evidence: (bundle: unknown) => { evidenceBundles.push(bundle); },
  };
}
let evidenceBundles: unknown[] = [];
beforeEach(() => { evidenceBundles = []; });

describe('sanitizeDownloadFilename / Content-Disposition', () => {
  it('剥离目录并替换非法字符', () => {
    expect(sanitizeDownloadFilename('../evil.exe')).toBe('evil.exe');
    expect(sanitizeDownloadFilename('a\\b:c*.txt')).toBe('a_b_c_.txt');
  });
  it('Windows 保留名加 _ 前缀；空名兜底 download', () => {
    expect(sanitizeDownloadFilename('CON')).toBe('_CON');
    expect(sanitizeDownloadFilename('con.txt')).toBe('_con.txt');
    expect(sanitizeDownloadFilename('')).toBe('download');
  });
  it('解析 Content-Disposition filename（引号/裸值/缺失）', () => {
    expect(filenameFromContentDisposition('attachment; filename="report.pdf"')).toBe('report.pdf');
    expect(filenameFromContentDisposition('attachment; filename=data.json')).toBe('data.json');
    expect(filenameFromContentDisposition(undefined)).toBe(undefined);
  });
});

describe('downloadFile', () => {
  it('真实流式下载成功落盘：字节一致 + sha256 证据 + 无临时残留', async () => {
    const { server, url } = await serve();
    const ws = tmp();
    const dest = join(ws, 'downloads');
    const evidence: unknown[] = [];
    try {
      const r = await downloadFile({ url, workspaceRoot: ws, destDir: dest }, { ...portsOf(), evidence: (b) => evidence.push(b) });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const bytes = readFileSync(r.value.filePath);
      expect(bytes.equals(BYTES)).toBe(true);
      expect(r.value.sha256).toBe(sha256(BYTES));
      expect(r.value.bytes).toBe(BYTES.length);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ url, sha256: sha256(BYTES), bytes: BYTES.length });
      expect(readdirSync(dest).filter(n => n.endsWith('.tmp'))).toHaveLength(0);
    } finally { server.close(); }
  });

  it('Content-Length 超上限 → DOWNLOAD_SIZE_LIMIT 预拒绝，零落盘', async () => {
    const { server, url } = await serve({ contentLength: 1_000_000 });
    const ws = tmp();
    const dest = join(ws, 'downloads');
    mkdirSync(dest, { recursive: true });
    try {
      const r = await downloadFile({ url, workspaceRoot: ws, destDir: dest, maxBytes: 100 }, portsOf());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('DOWNLOAD_SIZE_LIMIT');
      expect(readdirSync(dest)).toHaveLength(0);
    } finally { server.close(); }
  });

  it('流中超限（无 Content-Length）→ DOWNLOAD_SIZE_LIMIT，临时文件清理', async () => {
    const { server, url } = await serve({ body: Buffer.alloc(200, 7) });
    const ws = tmp();
    const dest = join(ws, 'downloads');
    mkdirSync(dest, { recursive: true });
    try {
      const r = await downloadFile({ url, workspaceRoot: ws, destDir: dest, maxBytes: 10 }, portsOf());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('DOWNLOAD_SIZE_LIMIT');
      expect(readdirSync(dest).filter(n => n.endsWith('.tmp'))).toHaveLength(0);
      expect(readdirSync(dest).filter(n => !n.endsWith('.tmp'))).toHaveLength(0);
    } finally { server.close(); }
  });

  it('Content-Disposition 文件名（含 ../ 注入）→ sanitize 后落盘', async () => {
    const { server, url } = await serve({ headers: { 'content-disposition': 'attachment; filename="../evil.exe"' } });
    const ws = tmp();
    const dest = join(ws, 'downloads');
    try {
      const r = await downloadFile({ url, workspaceRoot: ws, destDir: dest }, portsOf());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.fileName).toBe('evil.exe');
      expect(existsSync(join(dest, 'evil.exe'))).toBe(true);
    } finally { server.close(); }
  });

  it('目标目录越出工作区 → BUILD_PATH_OUTSIDE_WORKSPACE', async () => {
    const { server, url } = await serve();
    const ws = tmp();
    try {
      const r = await downloadFile({ url, workspaceRoot: ws, destDir: resolve(ws, '..') }, portsOf());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('BUILD_PATH_OUTSIDE_WORKSPACE');
    } finally { server.close(); }
  });

  it('授权层拒绝 → DOWNLOAD_URL_BLOCKED，不发起请求', async () => {
    const { server, url } = await serve();
    try {
      const r = await downloadFile({ url, workspaceRoot: tmp(), destDir: join(tmp(), 'd') }, portsOf(new Set(['http://other/'])));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('DOWNLOAD_URL_BLOCKED');
    } finally { server.close(); }
  });

  it('传输中断 → 下载失败且无半成品落盘（原子写）', async () => {
    const { server, url } = await serve({ truncateAt: 100 });
    const ws = tmp();
    const dest = join(ws, 'downloads');
    mkdirSync(dest, { recursive: true });
    try {
      const r = await downloadFile({ url, workspaceRoot: ws, destDir: dest }, portsOf());
      expect(r.ok).toBe(false);
      expect(readdirSync(dest).filter(n => !n.endsWith('.tmp'))).toHaveLength(0);
    } finally { server.close(); }
  });
});
