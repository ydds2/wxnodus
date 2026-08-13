// src/presentation/http/httpSecurity.ts — HTTP 传输安全：TLS/Host/Origin/forwarded-header 逐事实校验
import { isIP } from 'node:net';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';

export interface HttpSecurityConfig {
  bindHost: string;
  releaseMode: boolean;
  hostAllowlist: readonly string[];
  originAllowlist: readonly string[];
  trustedProxyCidrs: readonly string[];
  tls?: { minVersion: 'TLSv1.2' | 'TLSv1.3'; certificateTrust: 'system' | { pinnedSha256: readonly string[] } };
}

export interface HttpRequestFacts {
  headers: Record<string, string | undefined>;
  peerAddress: string;
  transport: { encrypted: boolean; tlsVersion?: string; certificateTrusted: boolean };
}

const loopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';

const ipv4 = (value: string) => value.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);

function inCidr(address: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split('/');
  if (isIP(address) !== 4 || isIP(network ?? '') !== 4) return address === network;
  const bits = Number(bitsText ?? 32);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4(address) & mask) === (ipv4(network!) & mask);
}

const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'];

export function validateHttpSecurityConfig(config: HttpSecurityConfig) {
  if (config.releaseMode && !loopback(config.bindHost) && !config.tls) {
    return err(gatewayError('HTTP_PLAINTEXT_NON_LOOPBACK_BLOCKED', 'release mode 禁止非 loopback 明文 HTTP', 'http.plaintext.non_loopback_blocked'));
  }
  return ok(config);
}

export function evaluateHttpTransport(config: HttpSecurityConfig, facts: HttpRequestFacts) {
  const host = (facts.headers.host ?? '').toLowerCase();
  const origin = facts.headers.origin;
  if (!config.hostAllowlist.map(x => x.toLowerCase()).includes(host)) {
    return err(gatewayError('HTTP_HOST_NOT_ALLOWED', 'Host 不在 allowlist', 'http.host.not_allowed'));
  }
  if (origin && !config.originAllowlist.includes(origin)) {
    return err(gatewayError('HTTP_ORIGIN_NOT_ALLOWED', 'Origin 不在 allowlist', 'http.origin.not_allowed'));
  }
  const trustedProxy = config.trustedProxyCidrs.some(cidr => inCidr(facts.peerAddress, cidr));
  if (!trustedProxy && forwarded.some(name => facts.headers[name] !== undefined)) {
    return err(gatewayError('HTTP_UNTRUSTED_FORWARDED_HEADER', '不信任 peer 提供的 forwarded header', 'http.forwarded.untrusted'));
  }
  if (config.tls) {
    if (!facts.transport.encrypted || !['TLSv1.2', 'TLSv1.3'].includes(facts.transport.tlsVersion ?? '')) {
      return err(gatewayError('HTTP_TLS_VERSION_UNSUPPORTED', 'TLS 版本低于 1.2', 'http.tls.version_unsupported'));
    }
    if (!facts.transport.certificateTrusted) {
      return err(gatewayError('HTTP_CERTIFICATE_UNTRUSTED', 'TLS 证书不可信', 'http.certificate.untrusted'));
    }
  }
  const clientIp = trustedProxy ? (facts.headers['x-forwarded-for']?.split(',')[0]?.trim() || facts.peerAddress) : facts.peerAddress;
  return ok({ clientIp, corsOrigin: origin });
}
