// scripts/check-test-count.mjs — Q8（2026-09-04 三轮评估轮1完善）：测试计数下限锁（ratchet）
// 背景：静态 it 计数（2700+）与运行展开计数（3000+）长期无核账——测试被静默删除/跳过不会被发现
// （评估报告 Q8：静态 2707 ≠ 运行 3031 无 ratchet）。本门禁：静态 it 计数 ≥ 下限，只升不降
// （删测试必须显式改本文件下限——drift 可见）。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 下限（2026-09-04 锚定：HEAD 940a22dd 实测静态 it 总数——只升不降；删测试须显式修改此行并说明理由） */
const MIN_STATIC_IT = 2720;

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(dir, e.name)) : (/\.test\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));

const files = [...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'src'))];
let count = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  // 匹配 it( / it.skip( / it.each 展开按字面 1 计（下限口径恒定即可）
  count += (text.match(/^\s*(it|test)(\.\w+)?\s*\(/gm) ?? []).length;
}

if (count < MIN_STATIC_IT) {
  console.error(`TEST_COUNT_FAIL: 静态 it 计数 ${count} < 下限 ${MIN_STATIC_IT}——测试被删或改名？`);
  console.error(`  （如属正当删除，显式修改 scripts/check-test-count.mjs 的 MIN_STATIC_IT 并在提交说明理由）`);
  process.exit(1);
}
console.log(`TEST_COUNT_OK: 静态 it ${count} ≥ 下限 ${MIN_STATIC_IT}（ratchet 只升不降）`);
