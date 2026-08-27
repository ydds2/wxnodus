// scripts/eval/task-selftest.mjs — 任务库自检（零模型依赖，入 ci 门禁）
// 对每个任务双向验证评分路径：
//   ① golden 参考解（solution.golden.mjs）→ verify.mjs 必须 PASS；
//   ② 无 solution.mjs → verify.mjs 必须 FAIL（评分脚本不失真）。
// 任一失真即 exit 1——防止「评分脚本永远放行」这类假绿。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TASKS = join(dirname(fileURLToPath(import.meta.url)), 'tasks');
const taskIds = readdirSync(TASKS).filter(d => existsSync(join(TASKS, d, 'task.md'))).sort();
if (!taskIds.length) { console.error('任务库为空'); process.exit(1); }

let failed = 0;
for (const id of taskIds) {
  const verify = join(TASKS, id, 'verify.mjs');
  const golden = join(TASKS, id, 'solution.golden.mjs');
  if (!existsSync(verify)) { console.error(`✗ ${id}: 缺 verify.mjs`); failed++; continue; }
  if (!existsSync(golden)) { console.error(`✗ ${id}: 缺 solution.golden.mjs`); failed++; continue; }
  const ws = mkdtempSync(join(tmpdir(), `wxn-task-selftest-${id}-`));
  try {
    cpSync(join(TASKS, id), ws, { recursive: true });
    rmSync(join(ws, 'solution.mjs'), { force: true });
    // ① golden → PASS
    cpSync(golden, join(ws, 'solution.mjs'));
    const ok = spawnSync(process.execPath, ['verify.mjs'], { cwd: ws, encoding: 'utf8', timeout: 30_000 });
    if (ok.status !== 0) {
      console.error(`✗ ${id}: golden 参考解未通过 verify（${String(ok.stdout).trim()} ${String(ok.stderr).trim()}`.trim() + ')');
      failed++;
      continue;
    }
    // ② 无解 → FAIL
    rmSync(join(ws, 'solution.mjs'), { force: true });
    const ng = spawnSync(process.execPath, ['verify.mjs'], { cwd: ws, encoding: 'utf8', timeout: 30_000 });
    if (ng.status === 0) {
      console.error(`✗ ${id}: 无 solution.mjs 却 PASS——评分脚本失真（永远放行）`);
      failed++;
      continue;
    }
    console.log(`✓ ${id}: golden PASS / 无解 FAIL（评分路径双向自检绿）`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}
if (failed) { console.error(`\n任务库自检失败：${failed} 项`); process.exit(1); }
console.log(`\n任务库自检全绿：${taskIds.length} 任务`);
