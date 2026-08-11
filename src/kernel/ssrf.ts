// src/kernel/ssrf.ts — SSRF 防护（共享：http_get 工具 / /claw 抓取）
// 设计：三层校验——① 主机名形态（IPv4 私网/保留段、IPv6 私网段、localhost、0.0.0.0）
//       ② DNS 解析后逐 IP 校验（防 DNS 重绑定：公网域名解析到内网 IP）
//       ③ 重定向逐跳校验（防 3xx 跳转进入内网；最多 5 跳）
import { lookup } from 'node:dns/promises';

// IPv4 私网/保留段（正则形态校验）
const IPV4_PRIVATE_RE =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|169\.254\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d)\.\d{1,3}\.\d{1,3})$/;
// IPv6 私网/保留段（前缀校验）
const IPV6_PRIVATE_PREFIXES = ['::1', 'fc', 'fd', 'fe80', 'fe8', 'fe9', 'fea', 'feb', '0:0:0:0:0:0:0:1', '::ffff:127.', '::ffff:10.', '::ffff:192.168.', '::ffff:172.'];

function isPrivateIpLiteral(ip: string): boolean {
  const low = ip.toLowerCase();
  if (IPV4_PRIVATE_RE.test(low)) return true;
  if (low === '::1' || low === '0:0:0:0:0:0:0:1') return true;
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

/** 完整 URL 安全检查：形态 + DNS 解析后逐 IP（防 DNS 重绑定） */
export async function checkUrlSafety(url: string): Promise<{ ok: boolean; reason?: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: 'URL 格式无效' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `协议不支持：${u.protocol}` };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) return { ok: false, reason: `内网/保留地址：${host}` };
  // DNS 解析后校验（防重绑定）——解析失败视为公网域名放行（由请求自身报错）
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && !host.includes(':')) {
    try {
      const addrs = await lookup(host, { all: true });
      for (const a of addrs) {
        if (isPrivateIpLiteral(a.address)) return { ok: false, reason: `DNS 解析到内网地址：${host} → ${a.address}（防 DNS 重绑定）` };
      }
    } catch { /* 解析失败由请求层报错 */ }
  }
  return { ok: true };
}

/** 带 SSRF 防护的 GET 请求（重定向逐跳校验，≤5 跳，15s 超时）；返回 { status, text } 或 { error } */
export async function safeFetchText(url: string, maxRedirects = 5): Promise<{ status: number; text: string } | { error: string }> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await checkUrlSafety(current);
    if (!check.ok) return { error: `已拦截：${check.reason}` };
    try {
      const resp = await fetch(current, {
        redirect: 'manual', // 手动跟随以逐跳校验
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) return { status: resp.status, text: '' };
        current = new URL(loc, current).toString();
        continue; // 下一跳继续校验
      }
      return { status: resp.status, text: await resp.text() };
    } catch (e: any) {
      return { error: `请求失败：${String(e?.message ?? e).slice(0, 300)}` };
    }
  }
  return { error: `重定向次数超限（${maxRedirects} 跳）——已终止` };
}
