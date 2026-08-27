// 评分脚本：对 solution.mjs 的 fibonacci 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const fibonacci = mod.fibonacci ?? mod.default?.fibonacci;
if (typeof fibonacci !== 'function') { console.error('FAIL: 未导出 fibonacci 函数'); process.exit(1); }
const cases = [[0, 0], [1, 1], [2, 1], [10, 55], [20, 6765], [30, 832040]];
let failed = 0;
for (const [n, expected] of cases) {
  const got = fibonacci(n);
  if (got !== expected) { console.error(`FAIL: fibonacci(${n}) = ${got}，期望 ${expected}`); failed++; }
}
if (failed) process.exit(1);
console.log('PASS: 6/6 断言全绿');
