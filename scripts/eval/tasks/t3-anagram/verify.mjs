// 评分脚本：对 solution.mjs 的 isAnagram 断言（零第三方依赖）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const solutionPath = join(here, 'solution.mjs');
if (!existsSync(solutionPath)) { console.error('FAIL: solution.mjs 不存在'); process.exit(1); }
let mod;
try { mod = await import(pathToFileURL(solutionPath).href); } catch (e) { console.error('FAIL: solution.mjs 无法加载：' + e.message); process.exit(1); }
const isAnagram = mod.isAnagram ?? mod.default?.isAnagram;
if (typeof isAnagram !== 'function') { console.error('FAIL: 未导出 isAnagram 函数'); process.exit(1); }
const cases = [
  ['listen', 'silent', true],
  ['Listen', 'Silent', true], // 忽略大小写
  ['rail safety', 'fairy tales', true], // 忽略空格
  ['hello', 'world', false],
  ['abc', 'ab', false],
];
let failed = 0;
for (const [a, b, expected] of cases) {
  const got = isAnagram(a, b);
  if (got !== expected) { console.error(`FAIL: isAnagram(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got}，期望 ${expected}`); failed++; }
}
if (failed) process.exit(1);
console.log('PASS: 5/5 断言全绿');
