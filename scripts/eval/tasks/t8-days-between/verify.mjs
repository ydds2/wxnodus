// 评分脚本：对 solution.mjs 的 daysBetween 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const daysBetween = mod.daysBetween ?? mod.default?.daysBetween;
if (typeof daysBetween !== 'function') { console.error('FAIL: 未导出 daysBetween 函数'); process.exit(1); }

const cases = [
  ['2024-01-01', '2024-01-01', 0],
  ['2024-01-01', '2024-01-03', 2],
  ['2024-02-28', '2024-03-01', 2],   // 闰年
  ['2023-02-28', '2023-03-01', 1],   // 非闰年
  ['2023-12-31', '2024-01-01', 1],   // 跨年
  ['2024-03-01', '2024-02-28', -2],  // 负方向
  ['1900-02-28', '1900-03-01', 1],   // 1900 非闰年
];

let failed = 0;
for (const [a, b, expected] of cases) {
  const got = daysBetween(a, b);
  if (got !== expected) { console.error(`FAIL: daysBetween('${a}', '${b}') = ${got}，期望 ${expected}`); failed++; }
}
if (failed) process.exit(1);
console.log('PASS: 7/7 断言全绿');
