// src/kernel/search.ts — 自研网页搜索（DuckDuckGo HTML 端点，无需 API key）
// 链路：safeFetchText（复用 SSRF 三层防护）抓取 html.duckduckgo.com/html/?q=...
//       → 自研 HTML 解析（result__a 标题/链接 + result__snippet 摘要 + DDG 跳转解码）
// 实体解码走 src/kernel/html.ts 共享解码器（完整数字引用 + 递归——根治 &amp;#236; 乱码）。
// 纯函数解析器直接单测（fixture HTML）；网络层可 mock。

import { decodeHtmlEntities } from './html.js';
import { safeFetchText } from './ssrf.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const stripTags = (s: string): string =>
  decodeHtmlEntities(
    String(s ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );

/** 清理 Bing 摘要噪声前缀：「8 小时之前 ·」「3 天前 ·」「2 分钟 ago ·」等 */
const BING_TS_PREFIX_RE = /^(?:\d+\s*(?:秒|分钟|小时|天|周|月|年)(?:之前|前|ago)?\s*[·•]\s*)+/i;

/** DDG 跳转解码：//duckduckgo.com/l/?uddg=<encoded> → 目标 URL；普通链接原样（相对转绝对需 base）。 */
export function decodeDdgUrl(href: string, base?: string): string {
  const h = decodeHtmlEntities(String(href ?? '').trim());

  if (!h) {
    return ''
  }

  try {
    const u = new URL(h.startsWith('//') ? `https:${h}` : h, base)
    const uddg = u.searchParams.get('uddg')

    if (uddg) {
      return uddg
    }

    return u.toString()
  } catch {
    return h
  }
}

/**
 * 解析 DDG HTML 结果页（自研：result__a 锚点 + result__snippet 摘要交替匹配）。
 * 解析不到任何结果时返回空数组（由调用方给出诚实提示）。
 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const anchors = [...String(html ?? '').matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis)];
  const snippets = [...String(html ?? '').matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/a>/gis)];
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < anchors.length; i++) {
    const m = anchors[i]!;
    const title = stripTags(m[2]!);

    if (!title) {
      continue;
    }

    const url = decodeDdgUrl(m[1]!);

    if (!url || url.includes('duckduckgo.com/l/')) {
      continue;
    }

    // 按 URL 去重（同页重复条目只保留首个）
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);

    results.push({
      title,
      url,
      snippet: stripTags(snippets[i]?.[1] ?? ''),
    });
  }

  return results.slice(0, 8);
}

/** 解析 Bing HTML 结果页（自研：b_algo 块——h2 链接 + b_caption 摘要）。
 * 国内网络下 DDG 常不可达，Bing 是免 key 回退引擎。 */
export function parseBingHtml(html: string): SearchResult[] {
  const blocks = [
    ...String(html ?? '').matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a><\/h2>([\s\S]*?)<\/li>/gis)
  ];
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const m of blocks) {
    const title = stripTags(m[2]!);

    if (!title) {
      continue;
    }

    // href 属性里的 &amp; 等实体必须解码（否则 URL 显示乱码且跳转参数错乱）
    const url = decodeHtmlEntities(String(m[1] ?? '').trim());

    if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }

    // 按 URL 去重
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);

    const snippetMatch = m[3]!.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripTags(snippetMatch?.[1] ?? '')
      // 去掉「N 小时之前 ·」类时间戳噪声前缀
      .replace(BING_TS_PREFIX_RE, '')
      .trim();

    results.push({ title, url, snippet });
  }

  return results.slice(0, 8);
}

/** 搜索 DuckDuckGo（安全通道：SSRF 防护 + 大小上限）；返回结果列表或错误。 */
export async function searchDuckDuckGo(
  query: string,
  opts: { maxResults?: number; proxy?: string } = {}
): Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string }> {
  const q = String(query ?? '').trim();

  if (!q) {
    return { ok: false, error: '搜索词为空' };
  }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  // 短超时（8s）+ 快速失败才重试：DDG 在国内常被墙（超时/连不上），
  // 重试无意义且放大等待——只有 <5s 的快速失败（瞬时抖动）才值得重试 1 次
  const attempt = async (): Promise<{ status: number; text: string } | { error: string; ms?: number }> => {
    const t0 = Date.now();
    const r = await safeFetchText(url, { maxBytes: 500_000, proxy: opts.proxy, timeoutMs: 8000 });
    return 'error' in r ? { ...r, ms: Date.now() - t0 } : r;
  };
  let r = await attempt();

  if ('error' in r && !String(r.error).includes('已拦截') && (r.ms ?? 9999) < 5000) {
    const retry = await attempt();
    if (!('error' in retry)) r = retry;
  }

  if ('error' in r) {
    return { ok: false, error: r.error };
  }

  const results = parseDuckDuckGoHtml(r.text);

  if (!results.length) {
    return { ok: false, error: `搜索无结果（HTTP ${r.status}）——DDG 可能返回了反爬页` };
  }

  return { ok: true, results: results.slice(0, opts.maxResults ?? 8) };
}

/** 搜索（DDG 优先，失败自动回退 Bing——国内网络 DDG 常不可达）。
 * 安全通道：SSRF 防护 + 大小上限；返回结果列表或错误。 */
export async function searchWeb(
  query: string,
  opts: { maxResults?: number; proxy?: string } = {}
): Promise<{ ok: true; results: SearchResult[]; engine: string } | { ok: false; error: string }> {
  const q = String(query ?? '').trim();

  if (!q) {
    return { ok: false, error: '搜索词为空' };
  }

  // 引擎 1：DuckDuckGo（隐私友好）
  const ddg = await searchDuckDuckGo(q, opts);

  if (ddg.ok) {
    return { ok: true, results: ddg.results, engine: 'duckduckgo' };
  }

  // 引擎 2：Bing（国内可达）——DDG 失败/反爬时自动回退
  const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(q)}`;
  const r = await safeFetchText(bingUrl, { maxBytes: 600_000, proxy: opts.proxy });

  if ('error' in r) {
    return { ok: false, error: `${ddg.error}；Bing 回退失败：${r.error}` };
  }

  const results = parseBingHtml(r.text);

  if (!results.length) {
    return { ok: false, error: `DDG：${ddg.error}；Bing 无结果（HTTP ${r.status}）` };
  }

  return { ok: true, results: results.slice(0, opts.maxResults ?? 8), engine: 'bing' };
}
