// 评分脚本：对 solution.mjs 的 deepMerge 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const deepMerge = mod.deepMerge ?? mod.default?.deepMerge;
if (typeof deepMerge !== 'function') { console.error('FAIL: 未导出 deepMerge 函数'); process.exit(1); }

const cases = [
  { a: { x: 1 }, b: { x: 2 }, expect: { x: 2 } },                       // 标量覆盖
  { a: { x: 1, keep: true }, b: { y: 3 }, expect: { x: 1, keep: true, y: 3 } }, // 并集
  { a: { n: { p: 1, q: 2 } }, b: { n: { p: 9 } }, expect: { n: { p: 9, q: 2 } } }, // 递归合并
  { a: { list: [1, 2] }, b: { list: [3] }, expect: { list: [3] } },      // 数组整体替换
  { a: { v: null }, b: { v: 's' }, expect: { v: 's' } },                 // null 被覆盖
  { a: { deep: { x: { y: 1 } } }, b: { deep: { x: { z: 2 } } }, expect: { deep: { x: { y: 1, z: 2 } } } }, // 深层递归
];

let failed = 0;
for (const { a, b, expect } of cases) {
  const aSnap = JSON.stringify(a);
  const bSnap = JSON.stringify(b);
  const got = deepMerge(a, b);
  const gotJson = JSON.stringify(got);
  if (gotJson !== JSON.stringify(expect)) {
    console.error(`FAIL: deepMerge(${aSnap}, ${bSnap}) = ${gotJson}，期望 ${JSON.stringify(expect)}`);
    failed++;
  }
  if (JSON.stringify(a) !== aSnap || JSON.stringify(b) !== bSnap) {
    console.error(`FAIL: 入参被修改（deepMerge(${aSnap}, ${bSnap})）`);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('PASS: 6/6 断言全绿');
