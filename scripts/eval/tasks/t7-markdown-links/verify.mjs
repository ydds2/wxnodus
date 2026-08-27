// 评分脚本：对 solution.mjs 的 extractLinks 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const extractLinks = mod.extractLinks ?? mod.default?.extractLinks;
if (typeof extractLinks !== 'function') { console.error('FAIL: 未导出 extractLinks 函数'); process.exit(1); }

const cases = [
  ['', []],
  ['[x](http://a)', [['x', 'http://a']]],
  ['a [x](http://a) b ![i](http://img) c [y](http://b) [z](http://a)', [['x', 'http://a'], ['y', 'http://b']]], // 忽略图片 + URL 去重
  ['![alt](http://img) only image', []],
  ['[中文](https://例.com/路径?q=1)', [['中文', 'https://例.com/路径?q=1']]], // 非 ASCII 文字与 URL
  ['[first](http://dup) middle [second](http://other) [third](http://dup)', [['first', 'http://dup'], ['second', 'http://other']]], // 保序去重
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = extractLinks(input);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`FAIL: extractLinks(${JSON.stringify(input)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('PASS: 6/6 断言全绿');
