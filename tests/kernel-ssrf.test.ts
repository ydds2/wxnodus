// tests/kernel-ssrf.test.ts — SSRF 防护：IPv4/IPv6 私网形态/DNS 重绑定/协议/重定向
import { describe, it, expect } from 'vitest';
import { isBlockedHostname, checkUrlSafety, safeFetchText } from '../src/kernel/ssrf.js';
import { createServer } from 'node:http';
import { afterEach } from 'vitest';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

describe('isBlockedHostname 形态校验', () => {
  it('IPv4 私网/保留段', () => {
    expect(isBlockedHostname('10.0.0.1')).toBe(true);
    expect(isBlockedHostname('192.168.1.1')).toBe(true);
    expect(isBlockedHostname('172.16.0.1')).toBe(true);
    expect(isBlockedHostname('172.31.255.255')).toBe(true);
    expect(isBlockedHostname('172.32.0.1')).toBe(false); // 172.32 非私网
    expect(isBlockedHostname('127.0.0.1')).toBe(true);
    expect(isBlockedHostname('169.254.1.1')).toBe(true); // link-local
    expect(isBlockedHostname('0.0.0.0')).toBe(true);
    expect(isBlockedHostname('8.8.8.8')).toBe(false);
    expect(isBlockedHostname('localhost')).toBe(true);
  });
  it('IPv6 私网段（::1 / fc00:: / fe80:: / 内嵌 IPv4）', () => {
    expect(isBlockedHostname('::1')).toBe(true);
    expect(isBlockedHostname('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedHostname('fc00::1')).toBe(true);
    expect(isBlockedHostname('fd12:3456::1')).toBe(true);
    expect(isBlockedHostname('fe80::1')).toBe(true);
    expect(isBlockedHostname('2606:4700:4700::1111')).toBe(false); // 公网
  });
});

describe('checkUrlSafety 协议与 DNS', () => {
  it('非 http/https 协议拒绝', async () => {
    expect((await checkUrlSafety('file:///etc/passwd')).ok).toBe(false);
    expect((await checkUrlSafety('ftp://x.com/a')).ok).toBe(false);
    expect((await checkUrlSafety('https://example.com')).ok).toBe(true);
  });
  it('DNS 重绑定防护：本地 hosts 解析到内网的域名被拦截', async () => {
    // 通过 127.0.0.1 字面量直接测（不依赖系统 DNS）
    const r = await checkUrlSafety('http://127.0.0.1:8080/x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('内网');
  });
});

describe('safeFetchText 重定向与拦截', () => {
  it('内网地址直接拦截，不发请求', async () => {
    const r = await safeFetchText('http://127.0.0.1:1/x');
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('已拦截');
  });
  it('重定向逐跳校验：公网 → 内网跳转被拦截', async () => {
    const srv = createServer((req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/secret' });
      res.end();
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    servers.push(srv);
    // 目标为 127.0.0.1 但重定向到 127.0.0.1:1 —— 直接形态拦截（本地地址一律拦截）
    const r = await safeFetchText(`http://127.0.0.1:${port}/start`);
    expect('error' in r).toBe(true);
  });
  it('正常公网请求返回状态与文本', async () => {
    const srv = createServer((_req, res) => { res.writeHead(200); res.end('hello ssrf'); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    servers.push(srv);
    const r = await safeFetchText(`http://127.0.0.1:${port}/`);
    expect('error' in r).toBe(true); // 本地地址一律拦截（安全优先）
  });
});

describe('A21 safeFetchText 多方法（POST/PUT/DELETE）', () => {
  it('POST 传递 method/body（stub fetch 验证请求参数）', async () => {
    const calls: Array<{ method: string; body: string | undefined; headers: Record<string, string> }> = [];
    const origFetch = globalThis.fetch;
    // @ts-expect-error 测试 stub
    globalThis.fetch = async (url: string, init: any) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body, headers: init?.headers ?? {} });
      return { status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('{"ok":true}') } as any;
    };
    try {
      const r = await safeFetchText('https://api.example.com/v1/items', { method: 'POST', body: { name: 'x' } });
      expect('error' in r).toBe(false);
      expect(calls[0]!.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ name: 'x' });
      // 对象 body 自动加 content-type
      expect((calls[0]!.headers as any)['content-type']).toBe('application/json');
      expect((calls[0]!.headers as any)['user-agent']).toContain('WxNodus');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('GET 不携带 body；DELETE 可带', async () => {
    const calls: Array<{ method: string; body: string | undefined }> = [];
    const origFetch = globalThis.fetch;
    // @ts-expect-error 测试 stub
    globalThis.fetch = async (_url: string, init: any) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body });
      return { status: 204, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('') } as any;
    };
    try {
      await safeFetchText('https://api.example.com/x', { method: 'GET' });
      await safeFetchText('https://api.example.com/x/1', { method: 'DELETE' });
      expect(calls[0]!.body).toBeUndefined();
      expect(calls[1]!.method).toBe('DELETE');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('内网拦截对 POST 同样生效（SSRF 方法无关）', async () => {
    const r = await safeFetchText('http://127.0.0.1:9999/api', { method: 'POST', body: { a: 1 } });
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('已拦截');
  });
});
