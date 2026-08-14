// src/application/forge/marketServer.ts — W5-01 市场分发 HTTP 服务（零框架 node:http；端口 0 临时分配）
// 变更端点（POST /keys · /publish · /revoke）前置管理策略：Bearer token 哈希 + scope + nonce 防重放 + body 上限；
// 每次变更经权威落审计哈希链。读端点（GET /catalog · /keys/:keyId · /items/:id）保持公开分发语义。
import { createServer, type Server } from 'node:http';
import type { MarketAuthority } from './marketAuthority.js';
import type { MarketPolicy } from './marketPolicy.js';

export interface MarketServerHandle {
  port: number;
  close(): Promise<void>;
}

const readBody = (req: import('node:http').IncomingMessage, maxBytes: number): Promise<{ body: unknown; tooLarge: boolean }> => new Promise(resolve => {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  req.on('data', chunk => {
    if (settled) return;
    total += chunk.length;
    if (total > maxBytes) {
      settled = true;
      resolve({ body: undefined, tooLarge: true });
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    const raw = Buffer.concat(chunks).toString('utf8');
    try { resolve({ body: raw ? JSON.parse(raw) : null, tooLarge: false }); } catch { resolve({ body: undefined, tooLarge: false }); }
  });
  req.on('error', () => { if (!settled) { settled = true; resolve({ body: undefined, tooLarge: false }); } });
});

const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

export function startMarketServer(authority: MarketAuthority, options: { policy: MarketPolicy }): Promise<MarketServerHandle> {
  const { policy } = options;
  return new Promise(resolve => {
    const server: Server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      try {
        if (method === 'POST' && url.pathname === '/keys') {
          const auth = policy.authorize({ authorization: req.headers.authorization, nonce: req.headers['x-market-nonce'] as string | undefined, action: 'keys:register' });
          if (!auth.ok) return send(res, auth.error.code === 'MARKET_FORBIDDEN' ? 403 : auth.error.code === 'MARKET_NONCE_REPLAYED' ? 409 : 401, { code: auth.error.code });
          const { body, tooLarge } = await readBody(req, policy.maxBodyBytes);
          if (tooLarge) return send(res, 413, { code: 'MARKET_BODY_TOO_LARGE' });
          const input = body as { keyId?: string; publicKeyPem?: string; generation?: number; authorizedByKeyId?: string; authorizedBySignature?: string } | null;
          if (!input || typeof input.keyId !== 'string' || typeof input.publicKeyPem !== 'string') return send(res, 400, { code: 'MARKET_KEY_INVALID' });
          const result = typeof input.generation === 'number' && input.authorizedByKeyId && input.authorizedBySignature
            ? authority.registerRoot({
              keyId: input.keyId, publicKeyPem: input.publicKeyPem, generation: input.generation,
              authorizedByKeyId: input.authorizedByKeyId, authorizedBySignature: input.authorizedBySignature,
            }, { actor: auth.value.actor, nonce: req.headers['x-market-nonce'] as string })
            : { ok: false, error: { code: 'MARKET_KEY_INVALID' } };
          return result.ok ? send(res, 201, { ok: true }) : send(res, 400, { code: result.error.code });
        }
        if (method === 'POST' && url.pathname === '/publish') {
          const auth = policy.authorize({ authorization: req.headers.authorization, nonce: req.headers['x-market-nonce'] as string | undefined, action: 'publish' });
          if (!auth.ok) return send(res, auth.error.code === 'MARKET_FORBIDDEN' ? 403 : auth.error.code === 'MARKET_NONCE_REPLAYED' ? 409 : 401, { code: auth.error.code });
          const { body, tooLarge } = await readBody(req, policy.maxBodyBytes);
          if (tooLarge) return send(res, 413, { code: 'MARKET_BODY_TOO_LARGE' });
          if (!body || typeof body !== 'object') return send(res, 400, { code: 'MARKET_PUBLISH_REJECTED' });
          const result = authority.publish(body as never, { actor: auth.value.actor, nonce: req.headers['x-market-nonce'] as string });
          return result.ok ? send(res, 201, { ok: true, entry: result.value }) : send(res, result.error.code === 'MARKET_ITEM_VERSION_CONFLICT' ? 409 : 400, { code: result.error.code });
        }
        if (method === 'POST' && url.pathname === '/revoke') {
          const auth = policy.authorize({ authorization: req.headers.authorization, nonce: req.headers['x-market-nonce'] as string | undefined, action: 'revoke' });
          if (!auth.ok) return send(res, auth.error.code === 'MARKET_FORBIDDEN' ? 403 : auth.error.code === 'MARKET_NONCE_REPLAYED' ? 409 : 401, { code: auth.error.code });
          const { body, tooLarge } = await readBody(req, policy.maxBodyBytes);
          if (tooLarge) return send(res, 413, { code: 'MARKET_BODY_TOO_LARGE' });
          const input = body as { id?: string } | null;
          if (!input || typeof input.id !== 'string') return send(res, 400, { code: 'MARKET_ITEM_NOT_FOUND' });
          const result = authority.revoke(input.id, { actor: auth.value.actor, nonce: req.headers['x-market-nonce'] as string });
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
