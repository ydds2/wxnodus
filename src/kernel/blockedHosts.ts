// src/kernel/blockedHosts.ts — 主机名/地址阻断判定（supremacy 3.5 环 17 修复：从 ssrf.ts 提取叶子）
// ssrf.ts 与 infrastructure/http/outboundTargetPolicy.ts 曾互相值导入（运行时环）——
// 阻断判定是纯函数，下沉为叶子模块；两者同向依赖本模块（不再互指）。
import { isIP } from 'node:net';

// IPv4 私网/保留段（正则形态校验）
const IPV4_PRIVATE_RE =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|169\.254\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d)\.\d{1,3}\.\d{1,3})$/;
// IPv6 私网/保留段（前缀校验）
const IPV6_PRIVATE_PREFIXES = ['::1', 'fc', 'fd', 'fe80', 'fe8', 'fe9', 'fea', 'feb', '0:0:0:0:0:0:0:1'];

/** IPv6 → IPv4 归一化：::ffff:a.b.c.d（含 hex 变体）与 64:ff9b::/96 NAT64 → IPv4 点分；非映射形式返回 null */
function v6ToV4(ip: string): string | null {
  const low = ip.toLowerCase();
  let m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(low);
  if (m) return m[1]!;
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
  if (m) {
    const a = parseInt(m[1]!, 16);
    const b = parseInt(m[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  m = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
  if (m) {
    const a = parseInt(m[1]!, 16);
    const b = parseInt(m[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** IP 字面量私网/保留判定（IPv4/IPv6/映射/NAT64 归一化——防 hex 变体绕过） */
export function isPrivateIpLiteral(ip: string): boolean {
  const low = ip.toLowerCase();
  if (isIP(low) === 4) {
    return IPV4_PRIVATE_RE.test(low);
  }
  if (low === '::1' || low === '0:0:0:0:0:0:0:1') return true;
  const v4 = v6ToV4(low);
  if (v4) return IPV4_PRIVATE_RE.test(v4);
  for (const p of IPV6_PRIVATE_PREFIXES) {
    if (low.startsWith(p)) return true;
  }
  return false;
}

/** 主机名形态校验（不解析 DNS） */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // 去 IPv6 括号
  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0') return true;
  return isPrivateIpLiteral(h);
}
