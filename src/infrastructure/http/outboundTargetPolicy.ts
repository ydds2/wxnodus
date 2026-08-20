// src/infrastructure/http/outboundTargetPolicy.ts — P0-08：出站目标授权（fail-closed）
// 非 http(s) scheme / 私有或保留目标 / DNS 解析失败 / 任一解析 IP 落入私网（防重绑定）→ 稳定拒绝。
// 与 legacy checkUrlSafety 不同：DNS 失败在此是拒绝（OUTBOUND_HTTP_DNS_UNRESOLVED），绝不放行由请求层报错。
import { lookup } from 'node:dns/promises';
import { isBlockedHostname } from '../../kernel/blockedHosts.js'; // 叶子直连（supremacy 3.5 环 17 修复）
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export type OutboundAuthorizationErrorCode =
  | 'OUTBOUND_HTTP_SCHEME_BLOCKED'
  | 'OUTBOUND_HTTP_TARGET_BLOCKED'
  | 'OUTBOUND_HTTP_DNS_UNRESOLVED'
  | 'OUTBOUND_HTTP_PRIVATE_TARGET';

export type OutboundAuthorization = OperationResult<{ targets: string[] }>;

const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const blocked = (code: OutboundAuthorizationErrorCode): OutboundAuthorization =>
  err(gatewayError(code, code, 'outboundHttp.target'));

export async function authorizeOutboundUrl(url: string): Promise<OutboundAuthorization> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return blocked('OUTBOUND_HTTP_TARGET_BLOCKED');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return blocked('OUTBOUND_HTTP_SCHEME_BLOCKED');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) return blocked('OUTBOUND_HTTP_TARGET_BLOCKED');

  // IP 字面量已通过私网校验（isBlockedHostname），无需 DNS
  if (IPV4_LITERAL.test(host) || host.includes(':')) {
    return ok({ targets: [host] });
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return blocked('OUTBOUND_HTTP_DNS_UNRESOLVED');
  }
  if (addresses.length === 0) return blocked('OUTBOUND_HTTP_DNS_UNRESOLVED');
  const targets = addresses.map(item => item.address);
  // 授权集合中的任一 IP 落入私网/保留段 → 拒绝（防 DNS 重绑定）
  if (targets.some(isBlockedHostname)) return blocked('OUTBOUND_HTTP_PRIVATE_TARGET');
  return ok({ targets });
}
