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

// L4 UI 组件行数预算（V4 L0-6，docs/output-spec-v1.md 工程规范）：
// 新组件 ≤400 行；既有超限组件进 ratchet 名单（只能降不能升——降至 ≤400 后移除条目）。
const COMPONENT_LINE_BUDGET = 400;
const COMPONENT_RATCHET = {
  'src/wxnodus-ui/components/textInput.tsx': 1540,
  'src/wxnodus-ui/components/thinking.tsx': 1243,
  'src/wxnodus-ui/components/markdown.tsx': 1185,
  'src/wxnodus-ui/components/agentsOverlay.tsx': 1158,
  'src/wxnodus-ui/components/activeSessionSwitcher.tsx': 1095,
  'src/wxnodus-ui/components/statusBar.tsx': 728,
  'src/wxnodus-ui/components/modelPicker.tsx': 970,
  'src/wxnodus-ui/components/appLayout.tsx': 565,
  'src/wxnodus-ui/components/branding.tsx': 502,
  'src/wxnodus-ui/components/messageLine.tsx': 449,
  'src/wxnodus-ui/components/appOverlays.tsx': 410,
};
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = f.slice(root.length + 1).replace(/\\/g, '/');
  if (/^\s*debugger\s*;?/m.test(text)) violations.push(`L1 debugger 残留：${rel}`);
  const inKernelLayer = /^src\/(kernel|infrastructure|domain)\//.test(rel);
  if (inKernelLayer && /process\.exit\s*\(/.test(text)) violations.push(`L2 分层红线（内核层不得 process.exit）：${rel}`);
  // L4：UI 组件行数预算（ratchet——allowlist 文件行数增长即失败；新组件超 400 即失败）
  if (rel.startsWith('src/wxnodus-ui/components/') && rel.endsWith('.tsx')) {
    const lines = text.split('\n').length;
    const ratchet = COMPONENT_RATCHET[rel];
    if (ratchet !== undefined) {
      if (lines > ratchet) violations.push(`L4 组件行数超 ratchet 预算：${rel} ${lines}>${ratchet}（只降不升；≤400 后移除条目）`);
    } else if (lines > COMPONENT_LINE_BUDGET) {
      violations.push(`L4 组件行数超 400 行预算：${rel} ${lines}（拆纯函数模块）`);
    }
  }
  todoCount += (text.match(/\bTODO\b|\bFIXME\b/g) ?? []).length;
}

if (violations.length) {
  console.error(`LINT_FAIL: ${violations.length} 项违反：`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`LINT_OK: ${files.length} 个源文件通过（L1 debugger / L2 内核层 exit 红线）；TODO/FIXME ${todoCount} 处（报告项）`);
