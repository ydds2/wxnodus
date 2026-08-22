// scripts/check-cycles.mjs — 循环依赖门禁（supremacy 3.5 / C-01，ci 挂载）
// 用 madge 检测 src/ 循环依赖；只把「全部节点都在 src/ 内」的环纳入判定
// allowlist：scripts/cycle-allowlist.json——已审计的良性环（type-only / 动态 import 边，
// 运行时无环）逐条登记理由；新增未知环 → 门禁失败（drift 可见）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import madge from 'madge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = join(root, 'scripts', 'cycle-allowlist.json');

const result = await madge(join(root, 'src'), {
  fileExtensions: ['ts', 'tsx'],
  tsConfig: join(root, 'tsconfig.json'),
});
const circular = result.circular(); // string[][]

const srcCycles = circular;

const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')).cycles ?? [];
// 旋转归一：环是无向集合——madge 遍历顺序随入口集变化（新增文件会改变报告方向，
// 2026-08-18 十四轮实测同一良性环被反方向报告）——按字典序最小节点起旋后比较
const normalizeCycle = (nodes) => {
  if (nodes.length <= 1) return nodes;
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i] < nodes[minIdx]) minIdx = i;
  return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
};
const chainOf = (nodes) => normalizeCycle(nodes).join(' > ');
const allowed = new Set(allowlist.map(c => chainOf(c.chain.split(' > '))));
const unknown = srcCycles.filter(cycle => !allowed.has(chainOf(cycle))).map(cycle => cycle.join(' > '));

if (unknown.length) {
  console.error(`CYCLE_GATE_FAIL: ${unknown.length} 个未登记循环依赖（新增环或修复后未更新 allowlist）：`);
  for (const c of unknown) console.error(`  - ${c}`);
  console.error('处置：修复环，或（仅当运行时无环——type-only/dynamic import 边）在 scripts/cycle-allowlist.json 登记理由。');
  process.exit(1);
}

// 反恒绿（2026-08-19 审计加固）：陈旧条目检测——修复掉的环仍留在 allowlist 即失败。
// 此前陈旧条目永不报警（把一切环塞进表即可消音）；现在修复环必须同步移除条目，allowlist 与实际环双向闭合。
const actual = new Set(srcCycles.map(cycle => chainOf(cycle)));
const stale = [...allowed].filter(entry => !actual.has(entry));
if (stale.length) {
  console.error(`CYCLE_GATE_FAIL: ${stale.length} 条 allowlist 陈旧条目（环已修复但未从登记表移除）：`);
  for (const c of stale) console.error(`  - ${c}`);
  console.error('处置：从 scripts/cycle-allowlist.json 删除对应 cycles 条目（修复环必须同步清理登记，防「登记即消音」）。');
  process.exit(1);
}

console.log(`CYCLE_GATE_OK: src 内部环 ${srcCycles.length} 个全部已登记（allowlist）`);
