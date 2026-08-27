// scripts/publish-release.mjs — 一键发布（当前私有仓库；公开后同一命令资产自然公开可拉）
// 用法：node scripts/publish-release.mjs --version 3.1.0 [--notes "说明"]
// 链路：freeze-candidate → package-installer（自包含 zip + manifest sha256 + install.ps1/install.bat）
//       → gh release create v<version> <zip>（私有 Release 资产；公开后 irm 直连即生效）
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const version = flag('version');
const notes = flag('notes') ?? `wxnodus ${version} 发布`;
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: publish-release.mjs --version <x.y.z[-prerelease]> [--notes <text>]');
  process.exit(2);
}
const run = (cmd) => { execSync(cmd, { cwd: ROOT, stdio: 'inherit', windowsHide: true }); };
const tag = `v${version}`;

// 1) 冻结 + 打包（校验门禁全部 fail-closed：CANDIDATE_INVALID/DEPENDENCY_CLOSURE_INCOMPLETE/PACKAGE_FAILED）
const runId = `release-${version}-${Date.now().toString(36)}`;
run(`node --import tsx scripts/freeze-candidate.ts --run ${runId}`);
run(`npm exec -- tsx scripts/package-installer.ts --candidate artifacts/release-evidence/${runId}/candidate.json --name wxnodus --version ${version} --out dist-installer`);
const zip = join(ROOT, 'dist-installer', `wxnodus-${version}.zip`);
if (!existsSync(zip)) { console.error(`RELEASE_ZIP_MISSING: ${zip}`); process.exit(2); }

// 2) gh release（私有仓库当前形态；公开后资产 URL 无需凭据）
run(`gh release create ${tag} "${zip}" --title "wxnodus ${version}" --notes "${notes}"`);
console.log(`RELEASED: ${tag}`);
console.log(`  zip: ${zip}`);
console.log('  install.ps1 入口（仓库内 packaging/install.ps1）');
console.log('  私有仓库一行装（gh 已登录）：gh api repos/ydds2/wxnodus/contents/packaging/install.ps1 -H "Accept: application/vnd.github.raw" | iex');
console.log('  公开后一行装：irm https://raw.githubusercontent.com/ydds2/wxnodus/master/packaging/install.ps1 | iex');
