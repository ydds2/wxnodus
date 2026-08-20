// scripts/generate-v3-compatibility.mjs — 生成/校验 V3 兼容清单（tsx 运行 TS 实现，避免双事实源）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const impl = resolve(root, 'scripts/generate-v3-compatibility.ts');

const result = spawnSync(process.execPath, [tsxCli, impl, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
