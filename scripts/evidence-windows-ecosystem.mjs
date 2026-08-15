// scripts/evidence-windows-ecosystem.mjs — Windows 生态互依证据入口（tsx 运行 TS 实现）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const impl = resolve(root, 'scripts/evidence-windows-ecosystem.ts');

const result = spawnSync(process.execPath, [tsxCli, impl, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
