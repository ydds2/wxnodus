// 评分脚本：对 solution.mjs 的 parseQuery 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const parseQuery = mod.parseQuery ?? mod.default?.parseQuery;
if (typeof parseQuery !== 'function') { console.error('FAIL: 未导出 parseQuery 函数'); process.exit(1); }

const cases = [
  ['', {}],
  ['a=1&b=2', { a: '1', b: '2' }],
  ['k=%E4%B8%AD&k=2', { k: ['中', '2'] }],          // 百分号解码 + 重复 key
  ['flag', { flag: '' }],                            // 无 = 项
  ['x=a%20b', { x: 'a b' }],                         // %20 解码
  ['p=a+b', { p: 'a+b' }],                           // + 不转空格
  ['u=%F0%9F%98%80', { u: '😀' }],                   // 四字节 UTF-8
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = parseQuery(input);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`FAIL: parseQuery(${JSON.stringify(input)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('PASS: 7/7 断言全绿');
