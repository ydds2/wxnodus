// src/kernel/html.ts — 共享 HTML 文本工具（搜索 /claw 抓取 /http_get 工具共用）
// 根治「&amp;#236; 乱码」：完整 HTML 实体解码（命名实体 + 十进制/十六进制数字引用 + 递归），
// 覆盖 Bing/DDG 双重编码与任意 Unicode 码点（&#236; → ì、&#x4e2d; → 中）。

// 常用命名实体表（HTML4 高频 + 中文页面常见）
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
  middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  laquo: '«', raquo: '»', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ',
  infin: '∞', ne: '≠', le: '≤', ge: '≥', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', ouml: 'ö', auml: 'ä', uuml: 'ü', eacute: 'é',
  agrave: 'à', egrave: 'è', iacute: 'í', igrave: 'ì', oacute: 'ó', uacute: 'ú',
};

/** 解码单个实体体（不含 & ;）；无效返回 null。 */
function decodeEntityBody(body: string): string | null {
  if (body.startsWith('#')) {
    const hex = /^#x/i.test(body);
    const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    // 码点安全过滤：0 无效、代理区、超上限、控制字符（保留 \t \n \r）、C1 区
    if (Number.isNaN(code) || code <= 0 || code > 0x10ffff) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return null;
    if (code >= 0x7f && code <= 0x9f) return null;
    return String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? null;
}

/**
 * 完整 HTML 实体解码：命名实体 + 数字引用（&#236; / &#x1F;，分号可选），
 * 递归最多 3 轮（Bing 双层编码 &amp;#236; → &#236; → ì）。无效实体原样保留。
 */
export function decodeHtmlEntities(s: string): string {
  let out = String(s ?? '');

  for (let round = 0; round < 3; round++) {
    const next = out.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body: string) => {
      const d = decodeEntityBody(body);
      return d === null ? m : d;
    });
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * HTML → 纯文本：剥离 script/style/svg/注释 → 去标签 → 完整实体解码 → 空白归一。
 * maxLen 可选截断（供 /claw 与 http_get 工具限制输出长度）。
 */
export function htmlToText(html: string, maxLen?: number): string {
  const text = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const decoded = decodeHtmlEntities(text);
  return maxLen ? decoded.slice(0, maxLen) : decoded;
}

/** 启发式判断文本是否为 HTML（http_get 工具据此决定是否正文抽取） */
export function looksLikeHtml(s: string): boolean {
  const t = String(s ?? '');
  return /<!doctype html|<\s*html[\s>]/i.test(t) || /<\s*(div|p|article|h[1-6]|li|ul|span|a)\b[\s>][\s\S]*?<\s*\/\s*(div|p|article|h[1-6]|li|ul|span|a)\s*>/i.test(t);
}
