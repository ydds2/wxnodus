// 评分脚本（t26-ip-validate）
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const p = join(here, 'solution.mjs');
if (!existsSync(p)) { console.error('FAIL: solution.mjs missing'); process.exit(1); }
const mod = await import(pathToFileURL(p).href);
const fn = mod.default;
if (typeof fn !== 'function') { console.error('FAIL: no default export'); process.exit(1); }
let failed = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error('FAIL: ' + label + ' got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
    failed++;
  }
}
check('valid ip', fn('192.168.1.1'), true);
check('invalid 256', fn('256.1.1.1'), false);

if (failed > 0) { console.error('FAIL: ' + failed + ' assertions failed'); process.exit(1); }
console.log('PASS: all assertions green');
