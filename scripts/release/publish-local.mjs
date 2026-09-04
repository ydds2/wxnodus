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


// T78 SDK 私有化：@wxnodus/sdk 发布产物为 dist（tsc -p packages/sdk）——先构建防旧产物上 npm
const sdkDist = resolve(ROOT, 'packages/sdk/dist/index.js');
if (!existsSync(sdkDist)) {
  console.log('→ packages/sdk/dist 缺失：先跑 npm run build:sdk …');
  const b = spawnSync('npm', ['run', 'build:sdk'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (b.status !== 0) { console.error('✗ build:sdk 失败——中止发布'); process.exit(1); }
}
// C-3（2026-08-30）：@wxnodus/core 同款 dist 守卫；其 wxnodus 依赖为 file:../..（开发自链），
// 发布时改写为根包版本号（lerna 同款 publish-time 版本改写），发布后还原——消费者拿到 registry 版本
const coreDist = resolve(ROOT, 'packages/core/dist/index.js');
if (!existsSync(coreDist)) {
  console.log('→ packages/core/dist 缺失：先跑 npm run build:core …');
  const b2 = spawnSync('npm', ['run', 'build:core'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (b2.status !== 0) { console.error('✗ build:core 失败——中止发布'); process.exit(1); }
}
const rootVersion = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const corePkgPath = resolve(ROOT, 'packages/core/package.json');
const corePkgRaw = readFileSync(corePkgPath, 'utf8');
if (JSON.parse(corePkgRaw).dependencies?.wxnodus === 'file:../..') {
  const rewritten = JSON.parse(corePkgRaw);
  rewritten.dependencies.wxnodus = rootVersion;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(corePkgPath, JSON.stringify(rewritten, null, 2) + '
');
  process.on('exit', () => { try { writeFileSync(corePkgPath, corePkgRaw); } catch { /* 还原失败如实留下版本号形态（下次 install 自愈） */ } });
  console.log(`→ packages/core 依赖改写 wxnodus: file:../.. -> ${rootVersion}（发布后自动还原）`);
}

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
