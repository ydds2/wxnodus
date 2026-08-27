// 评分脚本：对 solution.mjs 的 topWords 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const topWords = mod.topWords ?? mod.default?.topWords;
if (typeof topWords !== 'function') { console.error('FAIL: 未导出 topWords 函数'); process.exit(1); }

const cases = [
  ['', 3, []],
  ['!!! 123', 3, []],                                       // 无单词
  ['a b a c', 2, [['a', 2], ['b', 1]]],
  ['Hello, hello! world', 2, [['hello', 2], ['world', 1]]], // 大小写合并
  ['b a c b a a', 2, [['a', 3], ['b', 2]]],                 // 降序
  ['x y z', 2, [['x', 1], ['y', 1]]],                       // 同频按字典序
  ['a b c', 10, [['a', 1], ['b', 1], ['c', 1]]],            // k 超出返回全部
  ['word', 0, []],                                          // k<=0
];

let failed = 0;
for (const [input, k, expected] of cases) {
  const got = topWords(input, k);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`FAIL: topWords(${JSON.stringify(input)}, ${k}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('PASS: 8/8 断言全绿');
