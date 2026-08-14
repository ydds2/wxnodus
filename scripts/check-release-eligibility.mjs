// scripts/check-release-eligibility.mjs — W0-02 launcher：只启动 TypeScript eligibility adapter，不做本地验收判定。
// 用法：npm.cmd run check:release-eligibility -- --gates <path> [--required A,B,C,F,G]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const adapter = resolve(root, 'src/cli/checkReleaseEligibility.ts');

const result = spawnSync(process.execPath, [tsxCli, adapter, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});

process.exitCode = result.status ?? 1;
