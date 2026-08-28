// scripts/release/publish-local.mjs — npm 本地直发（Billing-free 路径 · 2026-08-28）
// 用途：不依赖 GitHub Actions（绕开账户 Billing 拦截）——本机直发三包到 npm。
// 前置：环境变量 NPM_TOKEN（npmjs Granular token，仅授权 wxnodus/@wxnodus/sdk/@wxnodus/core）。
// 用法：
//   NPM_TOKEN=npm_xxx node scripts/release/publish-local.mjs --dry-run   # 复核清单（无需 token 也可跑）
//   NPM_TOKEN=npm_xxx node scripts/release/publish-local.mjs             # 正式发布
// 顺序：wxnodus → @wxnodus/sdk → @wxnodus/core（任一失败即停，防半发布状态无提示）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dryRun = process.argv.includes('--dry-run');
const token = process.env.NPM_TOKEN ?? '';

const PACKAGES = [
  { dir: ROOT, name: 'wxnodus' },
  { dir: resolve(ROOT, 'packages/sdk'), name: '@wxnodus/sdk' },
  { dir: resolve(ROOT, 'packages/core'), name: '@wxnodus/core' },
];

console.log(`npm 本地直发：${dryRun ? 'DRY-RUN（复核清单）' : '正式发布'}${token ? '' : '（NPM_TOKEN 未设——dry-run 可继续，正式发布将失败）'}\n`);

let failures = 0;
for (const pkg of PACKAGES) {
  const pkgJson = resolve(pkg.dir, 'package.json');
  if (!existsSync(pkgJson)) { console.error(`✗ ${pkg.name}: 缺 package.json（${pkg.dir}）`); failures++; continue; }
  const meta = JSON.parse(readFileSync(pkgJson, 'utf8'));
  console.log(`→ ${pkg.name}@${meta.version}（${pkg.dir}）`);
  const args = ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])];
  const r = spawnSync('npm', args, {
    cwd: pkg.dir,
    stdio: 'inherit',
    env: { ...process.env, NODE_AUTH_TOKEN: token },
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error(`✗ ${pkg.name} 发布失败（exit ${r.status}）——中止后续包`);
    failures++;
    break;
  }
  console.log(`✓ ${pkg.name}\n`);
}

if (failures > 0) process.exit(1);
console.log(dryRun
  ? '\nDRY-RUN 完成——三包产物清单已复核。正式发布：NPM_TOKEN=<token> node scripts/release/publish-local.mjs'
  : '\n三包发布完成。验收：npm view wxnodus version && npm view @wxnodus/sdk version && npm view @wxnodus/core version');
