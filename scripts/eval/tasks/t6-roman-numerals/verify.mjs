// 评分脚本：对 solution.mjs 的 romanToInt 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const romanToInt = mod.romanToInt ?? mod.default?.romanToInt;
if (typeof romanToInt !== 'function') { console.error('FAIL: 未导出 romanToInt 函数'); process.exit(1); }

const cases = [
  ['III', 3],
  ['IV', 4],
  ['IX', 9],
  ['LVIII', 58],
  ['MCMXCIV', 1994],
  ['XLII', 42],
  ['MMMCMXCIX', 3999],
  ['DCC', 700],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = romanToInt(input);
  if (got !== expected) { console.error(`FAIL: romanToInt('${input}') = ${got}，期望 ${expected}`); failed++; }
}
if (failed) process.exit(1);
console.log('PASS: 8/8 断言全绿');
