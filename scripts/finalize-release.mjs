// scripts/finalize-release.mjs — W6-04：唯一 operator-facing release 终局入口（tsx 运行 TS 实现）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const impl = resolve(root, 'scripts/finalize-release.ts');

const result = spawnSync(process.execPath, [tsxCli, impl, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
