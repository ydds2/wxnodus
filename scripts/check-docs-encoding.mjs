// scripts/check-docs-encoding.mjs — docs 编码健康门禁（入 ci，防外部进程改写复发）
// 背景：本机曾两次出现 docs/*.md 被外部进程改写为 CR-only 行尾 / GBK 乱码、以及 BOM 丢失
// （无 BOM 的 UTF-8 中文在部分 Windows 查看器按 ANSI/GBK 显示成乱码）。
// 口径（docs/*.md 统一）：
//   ① UTF-8 BOM 必需（EF BB BF）——查看器兼容；
//   ② 严格 UTF-8 解码通过（非法序列 = GBK 改写痕迹）；
//   ③ 无 U+FFFD 替换符（不可逆损坏痕迹）；
//   ④ 非 CR-only 行尾（LF 计数 > 0 或零 CR）。
// 任一违反 → 列出文件并 exit 1。
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DOCS = join(ROOT, 'docs');

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(dir, e.name)) : (e.name.endsWith('.md') ? [join(dir, e.name)] : []));

const files = walk(DOCS).sort();
if (!files.length) { console.error('DOCS_EMPTY: docs 目录无 .md 文件'); process.exit(1); }

const strict = new TextDecoder('utf-8', { fatal: true });
const violations = [];
for (const file of files) {
  const bytes = readFileSync(file);
  const rel = file.slice(ROOT.length + 1);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try { text = strict.decode(hasBom ? bytes.subarray(3) : bytes); }
  catch { violations.push(`${rel}: INVALID_UTF8（GBK 改写痕迹）`); continue; }
  if (text.includes('\uFFFD')) { violations.push(`${rel}: U+FFFD（不可逆损坏）`); continue; }
  const cr = (text.match(/\r/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (cr > 0 && lf === 0) { violations.push(`${rel}: CR_ONLY（行尾被改写）`); continue; }
  if (!hasBom) violations.push(`${rel}: NO_BOM（无 BOM 的 UTF-8 中文在部分 Windows 查看器乱码）`);
}

if (violations.length) {
  console.error(`DOCS_ENCODING_FAIL: ${violations.length} 处违反编码口径：`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log(`DOCS_ENCODING_OK: ${files.length} 份 .md 全部 BOM + 严格 UTF-8 + LF 行尾`);
