// src/kernel/ssrf.ts — SSRF 防护（共享：http_get 工具 / /claw 抓取）
// 设计：三层校验——① 主机名形态（IPv4 私网/保留段、IPv6 私网段、localhost、0.0.0.0）
//       ② DNS 解析后逐 IP 校验（防 DNS 重绑定：公网域名解析到内网 IP）
//       ③ 重定向逐跳校验（防 3xx 跳转进入内网；最多 5 跳）
// 安全审查修复：IPv6 变体归一化——::ffff:a.b.c.d（含 hex 形式 7f00:1）与
// 64:ff9b::/96 NAT64 前缀映射回 IPv4 后复用私网校验（防云元数据/本机绕过）
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// IPv4 私网/保留段（正则形态校验）
const IPV4_PRIVATE_RE =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|169\.254\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d)\.\d{1,3}\.\d{1,3})$/;
// IPv6 私网/保留段（前缀校验）
const IPV6_PRIVATE_PREFIXES = ['::1', 'fc', 'fd', 'fe80', 'fe8', 'fe9', 'fea', 'feb', '0:0:0:0:0:0:0:1'];

/** IPv6 → IPv4 归一化：::ffff:a.b.c.d（含 hex 变体）与 64:ff9b::/96 NAT64 → IPv4 点分；非映射形式返回 null */
function v6ToV4(ip: string): string | null {
  const low = ip.toLowerCase();
  // IPv4-mapped: ::ffff:a.b.c.d 或 ::ffff:7f00:1（hex）
  let m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(low);
  if (m) return m[1]!;
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
  if (m) {
    const a = parseInt(m[1]!, 16);
    const b = parseInt(m[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  // NAT64: 64:ff9b::/96 —— 末尾 32 位为 IPv4（hex 形式）
  m = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
  if (m) {
    const a = parseInt(m[1]!, 16);
    const b = parseInt(m[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

function isPrivateIpLiteral(ip: string): boolean {
  const low = ip.toLowerCase();
  if (isIP(low) === 4) {
    return IPV4_PRIVATE_RE.test(low);
  }
  if (low === '::1' || low === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped / NAT64 归一化后复用 IPv4 校验（防 hex 变体绕过）
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
export interface SafeFetchOptions {
  /** 重定向上限（默认 5） */
  maxRedirects?: number;
  /** 响应体上限（默认 1MB——防内存炸弹） */
  maxBytes?: number;
  /** 附加请求头（UA 等） */
  headers?: Record<string, string>;
  /** HTTP 代理（settings.proxy——A20 接入原死配置） */
  proxy?: string;
  /** A21：HTTP 方法（默认 GET；POST/PUT/DELETE/PATCH——SSRF 防护方法无关） */
  method?: string;
  /** A21：请求体（对象自动 JSON 序列化并加 content-type） */
  body?: string | Record<string, unknown>;
  /** 单跳超时毫秒（默认 15000；搜索等对延迟敏感的场景可缩短——DDG 在国内常超时，缩短可加快回退） */
  timeoutMs?: number;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WxNodus/3.0 (+local CLI search)';

export async function safeFetchText(url: string, opts: SafeFetchOptions = {}): Promise<{ status: number; text: string } | { error: string }> {
  const { maxRedirects = 5, maxBytes = 1_000_000, headers = {}, proxy, timeoutMs = 15000 } = opts;
  const method = String(opts.method ?? 'GET').toUpperCase();
  // A21：请求体序列化（对象 → JSON + content-type；字符串原样）
  let bodyStr: string | undefined;
  const mergedHeaders = { ...headers };
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') {
      bodyStr = opts.body;
    } else {
      bodyStr = JSON.stringify(opts.body);
      if (!Object.keys(mergedHeaders).some(k => k.toLowerCase() === 'content-type')) {
        mergedHeaders['content-type'] = 'application/json';
      }
    }
  }
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await checkUrlSafety(current);
    if (!check.ok) return { error: `已拦截：${check.reason}` };

    if (proxy) {
      // 代理通道：Windows 10+ 内置 curl（SSRF 逐跳校验仍在 JS 侧完成）
      const r = await proxyFetchOnce(current, proxy, { maxBytes, headers: mergedHeaders, method, body: bodyStr, timeoutMs });
      if ('error' in r) return r;
      const { status, location, body } = r;
      if (status >= 300 && status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return { status, text: body };
    }

    try {
      const resp = await fetch(current, {
        redirect: 'manual', // 手动跟随以逐跳校验
        signal: AbortSignal.timeout(timeoutMs),
        method,
        body: method === 'GET' || method === 'HEAD' ? undefined : bodyStr,
        headers: { 'user-agent': DEFAULT_UA, ...mergedHeaders },
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) return { status: resp.status, text: '' };
        current = new URL(loc, current).toString();
        continue; // 下一跳继续校验
      }
      // A20：响应体上限（防内存炸弹）
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > maxBytes) {
        return { status: resp.status, text: buf.subarray(0, maxBytes).toString('utf8') + `\n[截断：响应超过 ${maxBytes} 字节上限]` };
      }
      return { status: resp.status, text: buf.toString('utf8') };
    } catch (e: any) {
      return { error: `请求失败：${String(e?.message ?? e).slice(0, 300)}` };
    }
  }
  return { error: `重定向次数超限（${maxRedirects} 跳）——已终止` };
}

/** 单跳代理请求（curl 系统工具）；返回状态/跳转目标/响应体 */
async function proxyFetchOnce(
  url: string,
  proxy: string,
  opts: { maxBytes: number; headers: Record<string, string>; method: string; body?: string; timeoutMs: number }
): Promise<{ status: number; location: string | null; body: string } | { error: string }> {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wxnodus-fetch-'));
  const outFile = join(dir, 'body.bin');
  const headerFile = join(dir, 'headers.txt');
  // 审查修复：临时目录整体清理（try/finally）——此前只 unlink 两个文件、目录本体
  // 与异常路径（ENOENT/错误返回）均残留，崩溃时含抓取内容的 body.bin 长留系统临时目录
  try {
  const args = [
    '-s', '-m', String(Math.ceil(opts.timeoutMs / 1000)),
    '--max-filesize', String(opts.maxBytes),
    '--proxy', proxy,
    '-A', DEFAULT_UA,
    '-X', opts.method,
    ...Object.entries(opts.headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
    '-D', headerFile,
    '-o', outFile,
  ];
  // A21：请求体（GET/HEAD 不传 body；字符串原样——二进制场景由调用方自行 base64）
  if (opts.body !== undefined && opts.method !== 'GET' && opts.method !== 'HEAD') {
    args.push('--data-binary', opts.body);
  }
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 });
  let body = '';
  try {
    if (r.status === 0) body = readFileSync(outFile, 'utf8');
  } catch { /* 文件未生成（错误响应） */ }
  if (r.status !== 0 && !body) {
    // A25：curl 缺失时如实归因（此前 ENOENT 裸抛到上层，与网络失败混为一谈）
    const err = r.error as NodeJS.ErrnoException | undefined
    if (err?.code === 'ENOENT') {
      return { error: '代理请求不可用：未找到 curl（Windows 10+ 内置 curl.exe；如被移除请重新安装或改用直连）' };
    }
    return { error: `代理请求失败（curl 退出码 ${r.status ?? '?'}）：${String(r.stderr ?? '').slice(0, 200)}` };
  }
  let status = 200;
  let location: string | null = null;
  try {
    const headers = readFileSync(headerFile, 'utf8');
    const statusMatch = headers.match(/^HTTP\/[\d.]+ (\d{3})/m);
    if (statusMatch) status = Number(statusMatch[1]);
    const locMatch = headers.match(/^location: (.+)$/im);
    if (locMatch) location = locMatch[1]!.trim();
  } catch { /* 头解析失败按 200 */ }
  return { status, location, body };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
