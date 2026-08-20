// src/kernel/html.ts — 共享 HTML 文本工具（搜索 /claw 抓取 /http_get 工具共用）
// 根治「&amp;#236; 乱码」：完整 HTML 实体解码（命名实体 + 十进制/十六进制数字引用 + 递归），
// 覆盖 Bing/DDG 双重编码与任意 Unicode 码点（&#236; → ì、&#x4e2d; → 中）。
import { labelTruncate } from './truncate.js';

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
  // 诚实截断标注（labelTruncate 统一口径）——模型知道正文有剩余
  return maxLen ? labelTruncate(decoded, maxLen, '内容过长——收窄范围或分段抓取续看') : decoded;
}

/** 启发式判断文本是否为 HTML（http_get 工具据此决定是否正文抽取） */
export function looksLikeHtml(s: string): boolean {
  const t = String(s ?? '');
  return /<!doctype html|<\s*html[\s>]/i.test(t) || /<\s*(div|p|article|h[1-6]|li|ul|span|a)\b[\s>][\s\S]*?<\s*\/\s*(div|p|article|h[1-6]|li|ul|span|a)\s*>/i.test(t);
}

/**
 * 正文提取（readability 式启发，与 htmlToText 互补）：
 *   ① 剥离噪音块（script/style/noscript/template/svg/iframe/注释/nav/footer/header/aside/form）
 *   ② 块级标签换行（保留段落结构）
 *   ③ 行评分（长度 + 中英文标点密度 + CJK 密度——正文比导航/页脚得分高），取高分块
 *   ④ 按原文顺序输出高分块（排序只为选块），实体解码
 * 用途：/search --content、/claw、http_get 的正文干净度优先路径（导航/页脚/广告噪声不入结果）。
 */
export function extractMainText(html: string, maxLen = 6000): string {
  let h = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|header|aside|form)[\s>][\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  const lines = h
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map(l => decodeHtmlEntities(l.replace(/\s+/g, ' ').trim()))
    .filter(l => l.length > 0);

  const score = (l: string): number => {
    const punct = (l.match(/[，。！？；：、,.!?;:（）()《》"“”'']/g) ?? []).length;
    const cjk = (l.match(/[\u4e00-\u9fff]/g) ?? []).length;
    return l.length + punct * 8 + Math.min(cjk, 60);
  };

  // 选块：按分数降序取（预算内），输出保持原文顺序
  const budget = maxLen;
  const picked = new Set<string>();
  let used = 0;
  for (const l of [...lines].sort((a, b) => score(b) - score(a))) {
    if (used + l.length > budget) {
      if (used > 0) continue; // 已有内容时跳过超预算行
      picked.add(l); used += l.length + 1; break; // 首行即超预算：仍纳入（labelTruncate 截断兜底，绝不静默空输出）
    }
    picked.add(l);
    used += l.length + 1;
  }
  const joined = lines.filter(l => picked.has(l)).join('\n');
  const dropped = lines.length - picked.size;
  const head = labelTruncate(joined, maxLen, '收窄范围或提高 maxLen 续看');
  // 低分块省略显式标注（模型知道正文还有未被选取的行）
  return dropped > 0 ? `${head}…[另有 ${dropped} 行低分块未选取（maxLen 预算）]` : head;
}
