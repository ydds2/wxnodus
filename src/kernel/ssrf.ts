// src/kernel/ssrf.ts — SSRF 防护（共享：http_get 工具 / /claw 抓取）
// 设计：三层校验——① 主机名形态（IPv4 私网/保留段、IPv6 私网段、localhost、0.0.0.0）
//       ② DNS 解析后逐 IP 校验（防 DNS 重绑定：公网域名解析到内网 IP）
//       ③ 重定向逐跳校验（防 3xx 跳转进入内网；最多 5 跳）
// P0-08：safeFetchText 的逐跳授权与响应体限制已接线 outboundTargetPolicy / boundedResponseReader
//（DNS 失败 fail-closed、按真实字节拒绝超限）；checkUrlSafety 保留为兼容导出（KF-011 regression 依赖）。
import { lookup } from 'node:dns/promises';
import { authorizeOutboundUrl } from '../infrastructure/http/outboundTargetPolicy.js';
import { readBoundedBody } from '../infrastructure/http/boundedResponseReader.js';
// supremacy 3.5（环 17 修复）：阻断判定下沉 kernel/blockedHosts.ts 叶子——本文件 re-export
// 保持旧导出面兼容（isPrivateIpLiteral 供 checkUrlSafety DNS 逐 IP 校验复用）
import { isBlockedHostname, isPrivateIpLiteral } from './blockedHosts.js';
export { isBlockedHostname } from './blockedHosts.js';

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
  /** 调用方取消信号；与单跳超时合并，重定向和代理 curl 共用。 */
  signal?: AbortSignal;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WxNodus/3.0 (+local CLI search)';

export async function safeFetchText(url: string, opts: SafeFetchOptions = {}): Promise<{ status: number; text: string } | { error: string }> {
  const { maxRedirects = 5, maxBytes = 1_000_000, headers = {}, proxy, timeoutMs = 15000, signal } = opts;
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
    if (signal?.aborted) return { error: '请求已取消' };
    // P0-08：逐跳授权走 outboundTargetPolicy（DNS 失败 fail-closed；解析集含私网即拒）
    const check = await authorizeOutboundUrl(current);
    if (!check.ok) return { error: `已拦截：${check.error.code}` };
    if (signal?.aborted) return { error: '请求已取消' };

    if (proxy) {
      // 代理通道：Windows 10+ 内置 curl；同一 signal 可终止运行中的子进程。
      const r = await proxyFetchOnce(current, proxy, { maxBytes, headers: mergedHeaders, method, body: bodyStr, timeoutMs, signal });
      if ('error' in r) return r;
      const { status, location, body } = r;
      if (status >= 300 && status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return { status, text: body };
    }

    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      // A2（2026-08-27）：出站统一 fetch——env 代理 + 私网段默认直连。
      // SSRF 判定已在本跳前完成（URL 层），代理只是传输；私网目标经 no_proxy 直连，
      // 到达前仍被 authorizeOutboundUrl 拒绝（策略不因代理打折）。
      const { createOutboundFetch } = await import('../infrastructure/http/outboundFetch.js');
      const resp = await createOutboundFetch().fetch(current, {
        redirect: 'manual', // 手动跟随以逐跳校验
        signal: requestSignal,
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
      // P0-08：按真实字节限制响应（Content-Length 预拒绝；超限取消流并拒绝——不再静默截断）
      const bounded = await readBoundedBody(resp, maxBytes);
      if (!bounded.ok) {
        return { error: `响应超过 ${maxBytes} 字节上限——已拒绝（${bounded.error.code}）` };
      }
      return { status: resp.status, text: bounded.value.bytes.toString('utf8') };
    } catch (e: any) {
      if (signal?.aborted) return { error: '请求已取消' };
      return { error: `请求失败：${String(e?.message ?? e).slice(0, 300)}` };
    }
  }
  return { error: `重定向次数超限（${maxRedirects} 跳）——已终止` };
}

/** 单跳代理请求（curl 系统工具）；返回状态/跳转目标/响应体 */
async function proxyFetchOnce(
  url: string,
  proxy: string,
  opts: { maxBytes: number; headers: Record<string, string>; method: string; body?: string; timeoutMs: number; signal?: AbortSignal }
): Promise<{ status: number; location: string | null; body: string } | { error: string }> {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wxnodus-fetch-'));
  const outFile = join(dir, 'body.bin');
  const headerFile = join(dir, 'headers.txt');
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
    if (opts.body !== undefined && opts.method !== 'GET' && opts.method !== 'HEAD') {
      args.push('--data-binary', opts.body);
    }
    args.push(url);

    const outcome = await new Promise<{ code: number | null; stderr: string; error?: NodeJS.ErrnoException }>(resolve => {
      const child = spawn('curl', args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        signal: opts.signal,
      });
      let stderr = '';
      child.stderr?.on('data', chunk => {
        if (stderr.length < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - stderr.length);
      });
      let spawnError: NodeJS.ErrnoException | undefined;
      child.once('error', cause => { spawnError = cause as NodeJS.ErrnoException; });
      child.once('close', code => resolve({ code, stderr, ...(spawnError ? { error: spawnError } : {}) }));
    });

    if (opts.signal?.aborted) return { error: '请求已取消' };
    let body = '';
    try {
      if (outcome.code === 0) body = readFileSync(outFile, 'utf8');
    } catch { /* 文件未生成（错误响应） */ }
    if (outcome.code !== 0 && !body) {
      if (outcome.error?.code === 'ENOENT') {
        return { error: '代理请求不可用：未找到 curl（Windows 10+ 内置 curl.exe；如被移除请重新安装或改用直连）' };
      }
      return { error: `代理请求失败（curl 退出码 ${outcome.code ?? '?'}）：${outcome.stderr.slice(0, 200)}` };
    }
    let status = 200;
    let location: string | null = null;
    try {
      const responseHeaders = readFileSync(headerFile, 'utf8');
      const statusMatch = responseHeaders.match(/^HTTP\/[\d.]+ (\d{3})/m);
      if (statusMatch) status = Number(statusMatch[1]);
      const locMatch = responseHeaders.match(/^location: (.+)$/im);
      if (locMatch) location = locMatch[1]!.trim();
    } catch { /* 头解析失败按 200 */ }
    return { status, location, body };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
