// 评分脚本：对 solution.mjs 的 csvSum 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const csvSum = mod.csvSum ?? mod.default?.csvSum;
if (typeof csvSum !== 'function') { console.error('FAIL: 未导出 csvSum 函数'); process.exit(1); }
const cases = [
  ['a,1\nb,2\nc,3', 6],
  ['x,-5', -5],
  ['only,42', 42],
  ['a,1\n\nb,2\n', 3], // 空行忽略
  ['负, -7\n正, 10', 3],
];
let failed = 0;
for (const [input, expected] of cases) {
  const got = csvSum(input);
  if (got !== expected) { console.error(`FAIL: csvSum(${JSON.stringify(input)}) = ${got}，期望 ${expected}`); failed++; }
}
if (failed) process.exit(1);
console.log('PASS: 5/5 断言全绿');
