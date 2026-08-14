// scripts/run-completion-gate.mjs — Gate G-W3 launcher：只启动 TypeScript authority adapter，不做任何本地完成判定。
// 用法：npm.cmd run gate:completion -- --run <uuid> [--evidence-root <path>]
// 退出码完全由 src/cli/runCompletionGate.ts 决定（0 succeeded / 1 failed / 2 blocked / 3 incomplete / 4 inconclusive / 130 cancelled）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const adapter = resolve(root, 'src/cli/runCompletionGate.ts');

const result = spawnSync(process.execPath, [tsxCli, adapter, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});

// 1 只代表 launcher 本身失败；adapter 的任何终态码（含 2/3/4/130）原样传播。
process.exitCode = result.status ?? 1;
