// scripts/check-docs-links.mjs — D1（2026-08-27）：文档断链门禁（ci 挂载）
// 扫描当前态文档（README/AGENTS/协议文档/08-27 评估与路线图）中两类引用：
//   ① markdown 链接 [text](path)（相对引用文件目录解析）
//   ② 反引号内的仓库相对路径 token（`docs/x.md`、`examples/y.mjs` 形态，相对仓库根）
// 豁免：
//   · 历史快照文档（*-2026-08-21*、output-spec-v1）——锚点指向 UI 删除前的文件，属档案不校验；
//   · 描述缺陷/规划产出的行（含 断链/悬空/不存在/已修/已清理/规划/产出 等字样）。
// 失败列出全部断链并 exit 1（fail-closed——此前 README 断链 3 份协议文档、
// AGENTS.md 悬空 audit-deep.md 均因无此门禁漏网）。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH_TOKEN = /^(docs|examples|packages|scripts|src|tests)\/[A-Za-z0-9._@/-]+\.(md|mjs|js|ts|tsx|json|yml|yaml|ps1|cmd|bat)$/;
// 历史快照：锚点属审计当时状态（UI 已于 ee63a5b2 移除），不作当前态校验
const HISTORICAL = new Set([
  'docs/production-readiness-plan-2026-08-21.md',
  'docs/wxnodus-master-upgrade-plan-2026-08-21.md',
  'docs/wxnodus-v4-plan-2026-08-21.md',
  'docs/wxnodus-4.0-hardening-plan-2026-08-21.md',
  'docs/output-spec-v1.md',
]);
// 缺陷记录/规划产出行——文档自述断链或未建产物，不算违规
const DEFECT_LINE = /断链|悬空|不存在|已修|已清理|已删除|规划|产出|未建|待建/;

const mdFiles = ['README.md', 'AGENTS.md', ...readdirSync(join(ROOT, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)];
const broken = [];

const check = (fromFile, rawPath, kind, resolveAgainstRoot) => {
  let p = String(rawPath).split('#')[0].split(':')[0].trim();
  if (!p || p.includes(' ') || /^(https?:)?\/\//.test(p) || p.includes('<') || p.includes('*') || p.includes('{')) return;
  const base = resolveAgainstRoot ? ROOT : join(ROOT, dirname(fromFile));
  const abs = resolve(base, p);
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..')) return; // 仓外路径不校验
  if (!existsSync(abs)) broken.push(`${fromFile} -> ${p}（${kind}）`);
};

for (const file of mdFiles) {
  if (HISTORICAL.has(file)) continue; // 历史快照整体豁免
  const text = readFileSync(join(ROOT, file), 'utf8');
  const lineAt = (index) => {
    const start = text.lastIndexOf('\n', index) + 1;
    const end = text.indexOf('\n', index);
    return text.slice(start, end === -1 ? undefined : end);
  };
  // ① markdown 链接（相对文档目录）
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (DEFECT_LINE.test(lineAt(m.index))) continue;
    check(file, m[1], 'link', false);
  }
  // ② 反引号 path token（相对仓库根；含行号后缀先剥掉）
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const token = m[1].trim();
    const base = token.split(':')[0];
    if (!PATH_TOKEN.test(base)) continue;
    if (DEFECT_LINE.test(lineAt(m.index))) continue;
    check(file, base, 'code-path', true);
  }
}

if (broken.length) {
  console.error(`DOCS_LINKS_FAIL: ${broken.length} 处断链：`);
  for (const b of broken) console.error(`  - ${b}`);
  process.exit(1);
}
console.log(`DOCS_LINKS_OK: ${mdFiles.length - HISTORICAL.size} 份当前态文档引用全通（历史快照 ${HISTORICAL.size} 份豁免）`);
