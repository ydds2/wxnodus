// src/presentation/http/csrfPolicy.ts — P0-01：CORS 预检与 CSRF 判定（纯函数，fail-closed）
// OPTIONS 预检必须验证 Origin/请求方法/请求头，绝不无条件 204；
// 跨源状态修改请求（含无 Origin 的浏览器跨站请求）稳定拒绝；无 Origin 的非浏览器客户端交由认证层。
export interface CsrfFacts {
  method: string;
  headers: Record<string, string | undefined>;
  originAllowlist: readonly string[];
  allowedMethods?: readonly string[];
  allowedHeaders?: readonly string[];
}

export type CsrfDecision =
  | { ok: true }
  | { ok: false; code: 'HTTP_CSRF_BLOCKED' | 'HTTP_CORS_PREFLIGHT_DENIED' };

const DEFAULT_METHODS = ['GET', 'POST', 'OPTIONS'] as const;
const DEFAULT_HEADERS = ['Content-Type', 'Authorization'] as const;

export function evaluateCsrf(facts: CsrfFacts): CsrfDecision {
  const method = facts.method.toUpperCase();
  const origin = facts.headers.origin;
  const requestedMethod = facts.headers['access-control-request-method'];
  const requestedHeaders = facts.headers['access-control-request-headers'];
  const secFetchSite = facts.headers['sec-fetch-site'];
  const allowedMethods = (facts.allowedMethods ?? DEFAULT_METHODS).map(m => m.toUpperCase());
  const allowedHeaders = (facts.allowedHeaders ?? DEFAULT_HEADERS).map(h => h.toLowerCase());

  // CORS 预检：有 ACRM 才是浏览器预检；curl 的裸 OPTIONS 无 ACRM，交认证层
  if (method === 'OPTIONS' && requestedMethod !== undefined) {
    if (origin === undefined) return { ok: true };
    if (!facts.originAllowlist.includes(origin)) return { ok: false, code: 'HTTP_CORS_PREFLIGHT_DENIED' };
    if (!allowedMethods.includes(requestedMethod.toUpperCase())) return { ok: false, code: 'HTTP_CORS_PREFLIGHT_DENIED' };
    if (requestedHeaders !== undefined) {
      const listed = requestedHeaders.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
      if (listed.length === 0 || listed.some(h => !allowedHeaders.includes(h))) {
        return { ok: false, code: 'HTTP_CORS_PREFLIGHT_DENIED' };
      }
    }
    return { ok: true };
  }

  // 状态修改请求的 CSRF 判定（GET/HEAD 不产生副作用，不拦截）
  if (method === 'GET' || method === 'HEAD') return { ok: true };
  if (origin !== undefined) {
    if (!facts.originAllowlist.includes(origin)) return { ok: false, code: 'HTTP_CSRF_BLOCKED' };
    return { ok: true };
  }
  // 无 Origin：浏览器跨站请求（form/旧客户端）可通过 Sec-Fetch-Site 识别；纯非浏览器客户端（curl）交认证层
  if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { ok: false, code: 'HTTP_CSRF_BLOCKED' };
  }
  return { ok: true };
}
