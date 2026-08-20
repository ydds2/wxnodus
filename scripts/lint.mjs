// scripts/lint.mjs — 结构性 lint（supremacy 3.5 / C-01，ci 挂载）
// 与 tsc 互补的确定性静态规则（零配置、零误报——只检确定性模式，不做风格裁决）：
//   L1 debugger 语句：src/ 内出现即失败（调试残留不可上线）
//   L2 分层红线：src/kernel|infrastructure|domain 内 process.exit 即失败（内核不得自杀进程——
//      退出语义归 cli/入口层，completionTransport 映射）
//   L3 报告项（不失败）：TODO/FIXME 计数（技术债可见性）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src');

const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};

const files = walk(SRC);
const violations = [];
let todoCount = 0;

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = f.slice(root.length + 1).replace(/\\/g, '/');
  if (/^\s*debugger\s*;?/m.test(text)) violations.push(`L1 debugger 残留：${rel}`);
  const inKernelLayer = /^src\/(kernel|infrastructure|domain)\//.test(rel);
  if (inKernelLayer && /process\.exit\s*\(/.test(text)) violations.push(`L2 分层红线（内核层不得 process.exit）：${rel}`);
  todoCount += (text.match(/\bTODO\b|\bFIXME\b/g) ?? []).length;
}

if (violations.length) {
  console.error(`LINT_FAIL: ${violations.length} 项违反：`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`LINT_OK: ${files.length} 个源文件通过（L1 debugger / L2 内核层 exit 红线）；TODO/FIXME ${todoCount} 处（报告项）`);
