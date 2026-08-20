// src/infrastructure/computer/urlPolicy.ts — URL 策略（计划原文）：初始导航/重定向/每次请求/表单/弹窗/worker/下载统一授权；
// 解析全部 A/AAAA 后拒绝 loopback/private/link-local/multicast/unspecified，并比对实际连接地址防 DNS rebinding
import { isIP } from 'node:net';
import type { OperationResult } from '../../protocol/results.js';

interface ResolverPort { resolve(hostname: string): Promise<string[]> }
const denyReason = (reason: string): OperationResult<never> => ({
  ok: false,
  error: {
    code: 'BROWSER_URL_POLICY_DENIED',
    message: 'URL is denied by network policy',
    messageKey: 'BROWSER_URL_POLICY_DENIED',
    retryable: false,
    details: { reason },
  },
});
const deniedAddress = (address: string): string | null => {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized.startsWith('::ffff:127.')) return 'loopback';
  if (normalized === '::' || normalized === '0.0.0.0') return 'unspecified';
  if (normalized.startsWith('fe80:') || normalized.startsWith('169.254.')) return 'link-local';
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private';
  if (normalized.startsWith('ff')) return 'multicast';
  if (isIP(normalized) !== 4) return null;
  const [a, b] = normalized.split('.').map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  return null;
};

export class UrlPolicy {
  constructor(private readonly resolver: ResolverPort) {}
  async authorize(value: string): Promise<OperationResult<{ url: string; addresses: string[] }>> {
    let url: URL;
    try { url = new URL(value); } catch { return denyReason('invalid-url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return denyReason('scheme');
    if (url.username || url.password) return denyReason('userinfo');
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return denyReason('localhost');
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolver.resolve(url.hostname);
    const reason = addresses.length === 0 ? 'dns-empty' : addresses.map(deniedAddress).find(value => value !== null);
    if (reason) return denyReason(reason);
    return { ok: true, value: { url: url.toString(), addresses: [...addresses].sort() } };
  }

  verifyConnectedAddress(authorized: { addresses: string[] }, connectedAddress: string): OperationResult<void> {
    return authorized.addresses.includes(connectedAddress) ? { ok: true, value: undefined } : {
      ok: false,
      error: {
        code: 'BROWSER_DNS_REBINDING_DETECTED',
        message: 'Connected address differs from the authorized DNS result',
        messageKey: 'BROWSER_DNS_REBINDING_DETECTED',
        retryable: false,
        details: { authorized: authorized.addresses, connectedAddress },
      },
    };
  }
}
