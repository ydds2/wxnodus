// scripts/package-installer.ts — 完整安装器打包 demo（§10-4 产品化入口）：
// 用法：npm exec -- tsx scripts/package-installer.ts --name <名称> --version <x.y.z> --entry <dist/cli.js> [--out <目录>] [--icon <emoji/文本>]
// 产出：<out>/<名称>-<版本>.zip（manifest.json + install.ps1 + 文件树）——解压后运行 install.ps1 即安装
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildInstallerPackage } from '../src/application/release/installerPackager.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const name = flag('--name');
const version = flag('--version');
const entry = flag('--entry');
const outDir = resolve(flag('--out') ?? 'dist-installer');
const icon = flag('--icon') ?? null;

if (!name || !version || !entry) {
  console.error('usage: package-installer.ts --name <appName> --version <x.y.z> --entry <entryFile> [--out <dir>] [--icon <text>]');
  process.exit(2);
}

// 收集入口文件所在目录树（相对路径 → 字节）——打包边界 = 目录，不越界
const entryAbs = resolve(entry);
const rootDir = join(entryAbs, '..');
const files = new Map<string, Buffer>();
const collect = (dir: string) => {
  for (const item of readdirSync(dir)) {
    const full = join(dir, item);
    if (statSync(full).isDirectory()) collect(full);
    else files.set(relative(rootDir, full).replace(/\\/g, '/'), readFileSync(full));
  }
};
collect(rootDir);

const packed = await buildInstallerPackage({
  appName: name,
  version,
  icon,
  entryPath: relative(rootDir, entryAbs).replace(/\\/g, '/'),
  files,
  outDir,
});
if (!packed.ok) {
  console.error(`PACKAGE_FAILED: ${packed.error.code}`);
  process.exit(1);
}
console.log(`PACKAGED: ${packed.value.zipPath}`);
console.log(`  zipSha256: ${packed.value.zipSha256}`);
console.log(`  entries: ${packed.value.entryCount} files + manifest.json + install.ps1`);
console.log(`  安装：解压后 powershell -ExecutionPolicy Bypass -File install.ps1 [-TargetDir <目录>]`);
