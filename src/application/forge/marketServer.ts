// src/application/forge/marketServer.ts — 远程市场分发 HTTP 服务（§10-3 完整集成）：
// POST /keys（公钥注册）· POST /publish（验签入目录）· GET /items/:id（200/404/410）· GET /catalog · GET /keys/:keyId（公钥分发）
// node:http 零框架；端口 0 临时分配（测试用）；请求体解析失败一律 400
import { createServer, type Server } from 'node:http';
import type { MarketAuthority } from './marketAuthority.js';

export interface MarketServerHandle {
  port: number;
  close(): Promise<void>;
}

const readBody = (req: import('node:http').IncomingMessage): Promise<unknown> => new Promise(resolve => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(undefined); }
  });
  req.on('error', () => resolve(undefined));
});

const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

export function startMarketServer(authority: MarketAuthority): Promise<MarketServerHandle> {
  return new Promise(resolve => {
    const server: Server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      try {
        if (method === 'POST' && url.pathname === '/keys') {
          const body = await readBody(req) as { keyId?: string; publicKeyPem?: string } | null;
          if (!body || typeof body.keyId !== 'string' || typeof body.publicKeyPem !== 'string') return send(res, 400, { code: 'MARKET_KEY_INVALID' });
          const result = authority.registerKeyPem(body.keyId, body.publicKeyPem);
          return result.ok ? send(res, 201, { ok: true }) : send(res, 400, { code: result.error.code });
        }
        if (method === 'POST' && url.pathname === '/publish') {
          const body = await readBody(req);
          if (!body || typeof body !== 'object') return send(res, 400, { code: 'MARKET_PUBLISH_REJECTED' });
          const result = authority.publish(body as never);
          return result.ok ? send(res, 201, { ok: true, entry: result.value }) : send(res, 400, { code: result.error.code });
        }
        if (method === 'POST' && url.pathname === '/revoke') {
          const body = await readBody(req) as { id?: string } | null;
          if (!body || typeof body.id !== 'string') return send(res, 400, { code: 'MARKET_ITEM_NOT_FOUND' });
          const result = authority.revoke(body.id);
          return result.ok ? send(res, 200, { ok: true }) : send(res, 404, { code: result.error.code });
        }
        if (method === 'GET' && url.pathname === '/catalog') {
          return send(res, 200, { catalog: authority.listCatalog(), digest: authority.catalogDigest() });
        }
        if (method === 'GET' && url.pathname.startsWith('/keys/')) {
          const result = authority.publicKeyPem(decodeURIComponent(url.pathname.slice('/keys/'.length)));
          return result.ok ? send(res, 200, { keyId: url.pathname.slice('/keys/'.length), publicKeyPem: result.value }) : send(res, 404, { code: result.error.code });
        }
        if (method === 'GET' && url.pathname.startsWith('/items/')) {
          const result = authority.getItem(decodeURIComponent(url.pathname.slice('/items/'.length)));
          if (!result.ok) {
            return result.error.code === 'MARKET_ITEM_REVOKED' ? send(res, 410, { code: result.error.code }) : send(res, 404, { code: result.error.code });
          }
          return send(res, 200, result.value);
        }
        send(res, 404, { code: 'MARKET_ROUTE_NOT_FOUND' });
      } catch {
        send(res, 500, { code: 'MARKET_SERVER_ERROR' });
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
      });
    });
  });
}
