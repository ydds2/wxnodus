// 评分脚本：对 solution.mjs 的 evalArith 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const evalArith = mod.evalArith ?? mod.default?.evalArith;
if (typeof evalArith !== 'function') { console.error('FAIL: 未导出 evalArith 函数'); process.exit(1); }

const cases = [
  ['0', 0],
  ['42', 42],
  ['1+2*3', 7],          // 优先级
  ['(1+2)*3', 9],        // 括号
  ['2*(3+4*5)', 46],     // 嵌套
  ['10/3', 3],           // 向零截断
  ['-10/3', -3],         // 一元负号 + 截断
  ['7-2-3', 2],          // 同级左结合
  ['-3+5', 2],
  ['100-96/4*2+1', 53],  // 综合：100 - 48 + 1
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = evalArith(input);
  if (got !== expected) { console.error(`FAIL: evalArith('${input}') = ${got}，期望 ${expected}`); failed++; }
}
if (failed) process.exit(1);
console.log('PASS: 10/10 断言全绿');
