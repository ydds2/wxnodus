// tests/outbound-fetch.test.ts — A2（2026-08-27）：出站统一 fetch（企业代理面）
// 覆盖：env 代理路由生效（CONNECT 隧道）/ 私网直连红线（127.0.0.1 绕过代理）/ 无代理零开销 / mergeNoProxy 纯函数。
// 全部走本地 mock 服务器，零外网依赖。注意：undici EnvHttpProxyAgent 对 http 目标也发
// CONNECT——mock 代理必须忠实实现「200 Connection Established」隧道握手（否则无限重连）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';

const listen = (s: Server | NetServer): Promise<number> => new Promise(res => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));

// 注意：Windows 环境变量大小写不敏感（HTTP_PROXY 与 http_proxy 是同一底层变量）——
// 辅助函数只操作大写名，避免「删小写把刚设的大写一并删掉」。
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const;

/** 每测试独立 env + 独立模块实例（模块单例按首次构造缓存——resetModules 隔离） */
async function freshOutbound(env: Record<string, string | undefined>): Promise<ReturnType<typeof import('../src/infrastructure/http/outboundFetch.js')['createOutboundFetch']>> {
  vi.resetModules();
  const prev: Record<string, string | undefined> = {};
  for (const k of PROXY_KEYS) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!;
  }
  try {
    const mod = await import('../src/infrastructure/http/outboundFetch.js');
    return mod.createOutboundFetch();
  } finally {
    for (const k of PROXY_KEYS) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!;
    }
  }
}

/** 忠实 CONNECT 代理 mock：CONNECT → 200 Connection Established → 隧道内应答固定正文 */
const startMockProxy = (): Promise<{ port: number; hits: string[]; close: () => void }> => {
  const hits: string[] = [];
  const srv = createNetServer(sock => {
    let phase: 'head' | 'tunnel' = 'head';
    let buf = '';
    const respond = () => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nproxied-body');
      sock.end();
    };
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        const line = head.split('\r\n')[0] ?? '';
        if (phase === 'head' && line.startsWith('CONNECT')) {
          hits.push(line);
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          phase = 'tunnel';
          continue; // 隧道内继续解析真实请求
        }
        hits.push(line);
        respond();
        return;
      }
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ port: (srv.address() as { port: number }).port, hits, close: () => srv.close() })));
};

afterEach(() => { vi.restoreAllMocks(); });

describe('A2 outboundFetch（企业代理）', () => {
  it('env 代理生效：非私网目标经 CONNECT 隧道代理转发（连接只到 mock 代理，零真实网络）', async () => {
    const proxy = await startMockProxy();
    try {
      const outbound = await freshOutbound({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` });
      expect(outbound.proxyDescription).toContain('HTTP_PROXY');
      expect(outbound.proxyDescription).toContain('私网段默认直连');
      // 8.8.8.8 为公网字面 IP（不在私网直连段）→ 必须走代理；字面 IP 无 DNS 依赖
      const r = await outbound.fetch('http://8.8.8.8/hello');
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('proxied-body');
      expect(proxy.hits.some(h => h.startsWith('CONNECT'))).toBe(true);
      expect(proxy.hits.some(h => h.includes('/hello'))).toBe(true);
    } finally { proxy.close(); }
  });

  it('私网直连红线：127.0.0.1 目标绕过代理直达（代理零流量）', async () => {
    const proxy = await startMockProxy();
    const direct = createServer((req, res) => res.end('direct-ok'));
    const directPort = await listen(direct);
    try {
      const outbound = await freshOutbound({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` });
      const r = await outbound.fetch(`http://127.0.0.1:${directPort}/private`);
      expect(await r.text()).toBe('direct-ok');
      expect(proxy.hits).toHaveLength(0); // 私网段绝不外发
    } finally { proxy.close(); direct.close(); }
  });

  it('用户 NO_PROXY 归一化传递（纯包装层私网直连优先，见 isPrivateHost 单测）', async () => {
    const proxy = await startMockProxy();
    const direct = createServer((req, res) => res.end('no-proxy-direct'));
    const directPort = await listen(direct);
    try {
      const outbound = await freshOutbound({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: 'example.internal' });
      const r = await outbound.fetch(`http://127.0.0.1:${directPort}/x`);
      expect(await r.text()).toBe('no-proxy-direct');
      expect(proxy.hits).toHaveLength(0);
    } finally { proxy.close(); direct.close(); }
  });

  it('无代理环境：零开销直连 + proxyDescription 为 null', async () => {
    const direct = createServer((req, res) => res.end('plain'));
    const directPort = await listen(direct);
    try {
      const outbound = await freshOutbound({ HTTP_PROXY: undefined, HTTPS_PROXY: undefined });
      expect(outbound.proxyDescription).toBe(null);
      const r = await outbound.fetch(`http://127.0.0.1:${directPort}/x`);
      expect(await r.text()).toBe('plain');
    } finally { direct.close(); }
  });
});

describe('A2 isPrivateHost / mergeNoProxy（纯函数）', () => {
  it('私网/回环/链路本地/ULA 判定（IPv4/IPv6/localhost）', async () => {
    vi.resetModules();
    const { isPrivateHost } = await import('../src/infrastructure/http/outboundFetch.js');
    for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', 'localhost', '::1', 'fd12::1', 'fe80::1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['8.8.8.8', '1.1.1.1', '223.5.5.5', 'api.deepseek.com', 'example.com']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
    expect(isPrivateHost('172.32.0.1')).toBe(false); // 172.32 已出私网段
    expect(isPrivateHost('172.15.0.1')).toBe(false);
  });

  it('用户 NO_PROXY 归一化：去重保序小写', async () => {
    vi.resetModules();
    const { mergeNoProxy } = await import('../src/infrastructure/http/outboundFetch.js');
    const parts = mergeNoProxy('Example.INTERNAL, *.corp.local, EXAMPLE.internal').split(',');
    expect(parts).toEqual(['example.internal', '*.corp.local']);
    expect(mergeNoProxy(undefined)).toBe('');
  });

  it('matchProxyOverride：精确 / *.后缀 / *前缀 / <local>（WinINET ProxyOverride 语义子集）', async () => {
    vi.resetModules();
    const { matchProxyOverride } = await import('../src/infrastructure/http/outboundFetch.js');
    const list = '*.corp.local;gitlab.internal;<local>;*dev';
    expect(matchProxyOverride('a.corp.local', list)).toBe(true);
    expect(matchProxyOverride('corp.local', list)).toBe(true); // *.corp.local 覆盖裸域
    expect(matchProxyOverride('gitlab.internal', list)).toBe(true);
    expect(matchProxyOverride('mydev', list)).toBe(true);
    expect(matchProxyOverride('intranet-srv', list)).toBe(true); // <local>：无点号主机名
    expect(matchProxyOverride('api.deepseek.com', list)).toBe(false);
    expect(matchProxyOverride('anything.com', list)).toBe(false); // <local> 不等于全部直连
    expect(matchProxyOverride('corp.local.evil.com', list)).toBe(false);
  });
});

describe('A2 winInetProxy 解析（纯函数）', () => {
  it('parseProxyServerValue：全协议单值 / 分协议 https 优先 / 非法诚实 null', async () => {
    vi.resetModules();
    const { parseProxyServerValue } = await import('../src/infrastructure/http/winInetProxy.js');
    expect(parseProxyServerValue('10.0.0.1:8080')).toBe('10.0.0.1:8080');
    expect(parseProxyServerValue('http=10.0.0.1:8080;https=10.0.0.2:8443')).toBe('10.0.0.2:8443'); // https 优先
    expect(parseProxyServerValue('ftp=10.0.0.1:21')).toBe(null); // 无 http/https
    expect(parseProxyServerValue('')).toBe(null);
    expect(parseProxyServerValue('=broken')).toBe(null);
  });
});
