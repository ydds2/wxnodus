// scripts/check-registry-consistency.mjs — Q2（2026-09-04）：registry 三表一致性门禁
// 自 .tmp/guide-vs-registry.mts 等会话审计脚本正式化（评估报告 Q2：审计未挂 ci）。
// 对账三面（全部源自单一事实源 registry，运行期 import dist——ci 链中 build 先于 checks）：
//   ① SLASH 命令注册表（唯一事实源）
//   ② COMMAND_DESC / COMMAND_CAT 键集（帮助/分类目录——每命令必须有 desc 与 cat）
//   ③ docs/user-guide.md 命令表（用户文档不撒谎——行数与注册表动态一致）
// 任一不等或集合不一致 → 列差异并 exit 1（fail-closed）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SLASH, COMMAND_DESC, COMMAND_CAT } = await import(pathToFileURL(join(ROOT, 'dist/commands/registry.js')).href);

const reg = new Set(SLASH);
const desc = new Set(Object.keys(COMMAND_DESC));
const cat = new Set(Object.keys(COMMAND_CAT));

const guide = readFileSync(join(ROOT, 'docs', 'user-guide.md'), 'utf8');
const guideCmds = new Set();
for (const line of guide.split('\n')) {
  const m = /^\|\s*`(\/[a-z0-9-]+)`/.exec(line);
  if (m) guideCmds.add(m[1]);
}

const tables = { registry: reg, desc, cat, userGuide: guideCmds };
const problems = [];
for (const [name, set] of Object.entries(tables)) {
  if (set.size !== reg.size) problems.push(`${name} 计数 ${set.size} ≠ registry ${reg.size}`);
  for (const other of Object.entries(tables)) {
    if (other[0] === name) continue;
    const diff = [...set].filter(c => !other[1].has(c));
    if (diff.length) problems.push(`${name} 多出（${other[0]} 缺）: ${diff.join(' ')}`);
  }
}

if (problems.length) {
  console.error(`REGISTRY_CONSISTENCY_FAIL（${problems.length} 处）:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`REGISTRY_CONSISTENCY_OK: ${reg.size}=${desc.size}=${cat.size}=${guideCmds.size}（registry=desc=cat=user-guide）`);
