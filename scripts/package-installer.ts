// scripts/package-installer.ts — DX-04：安装器打包入口（只消费冻结 candidate，绝不猜 dist/cli）
// 用法：npm exec -- tsx scripts/package-installer.ts --candidate <candidate.json> --name <appName> --version <x.y.z> [--out <dir>] [--icon <text>]
// candidate.json（冻结）：{ candidateId, commit, tgzSha256, cell:{os,arch,node}, entrypoint, dynamicImportDeclarations: [] }
// 流程：validateFrozenInstallerCandidate → dist 树 + node_modules 生产依赖闭包（collectDependencyClosure）
//       → scanDistImportSpecifiers + verifyDependencyClosure（缺依赖 → INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE）
//       → buildInstallerPackage（manifest 全量 sha256 + 确定性 zip + 读回自校验）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstallerPackage } from '../src/application/release/installerPackager.js';
import { validateFrozenInstallerCandidate, type FrozenInstallerCandidate } from '../src/application/release/installerCandidate.js';
import { collectDependencyClosure, scanDistImportSpecifiers, stageClosureEntries, verifyDependencyClosure } from '../src/application/release/dependencyClosure.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const candidateFile = flag('--candidate');
const name = flag('--name');
const version = flag('--version');
const outDir = resolve(flag('--out') ?? 'dist-installer');
const icon = flag('--icon') ?? null;

if (!candidateFile || !name || !version) {
  console.error('usage: package-installer.ts --candidate <candidate.json> --name <appName> --version <x.y.z> [--out <dir>] [--icon <text>]');
  process.exit(2);
}

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// 冻结 candidate 文件（只读输入——candidate 由发布冻结流程生成，脚本绝不猜测）
const raw = JSON.parse(readFileSync(candidateFile, 'utf8')) as FrozenInstallerCandidate;
const staged = new Map<string, Buffer>();
const collect = (dir: string, base: string) => {
  for (const item of readdirSync(dir)) {
    const full = join(dir, item);
    if (statSync(full).isDirectory()) collect(full, base);
    else staged.set(relative(base, full).replace(/\\/g, '/'), readFileSync(full));
  }
};
// staged tree：dist（candidate 冻结的入口所在运行时树）+ node_modules 生产依赖闭包
// （闭包键相对 node_modules——必须还原 node_modules/ 前缀，否则依赖平铺到安装根目录、运行时解析失败）
collect(join(ROOT, 'dist'), ROOT);
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const closure = collectDependencyClosure(join(ROOT, 'node_modules'), Object.keys(rootPkg.dependencies ?? {}));
for (const [path, bytes] of stageClosureEntries(closure.files)) staged.set(path, bytes);

const candidate: FrozenInstallerCandidate = { ...raw, stagedTree: staged };
const validated = validateFrozenInstallerCandidate(candidate);
if (!validated.ok) {
  console.error(`CANDIDATE_INVALID: ${validated.error.code} ${JSON.stringify(validated.error.details ?? {})}`);
  process.exit(2);
}
const specifiers = scanDistImportSpecifiers(join(ROOT, 'dist'));
const closureCheck = verifyDependencyClosure(specifiers, closure, raw.dynamicImportDeclarations ?? []);
if (!closureCheck.ok) {
  console.error(`DEPENDENCY_CLOSURE_INCOMPLETE: ${JSON.stringify(closureCheck.error.details ?? {})}`);
  process.exit(2);
}

const packed = await buildInstallerPackage({
  appName: name,
  version,
  icon,
  entryPath: candidate.entrypoint,
  files: staged,
  outDir,
});
if (!packed.ok) {
  console.error(`PACKAGE_FAILED: ${packed.error.code}`);
  process.exit(1);
}
console.log(`PACKAGED: ${packed.value.zipPath}`);
console.log(`  candidate: ${candidate.candidateId} @ ${candidate.commit}`);
console.log(`  zipSha256: ${packed.value.zipSha256}`);
console.log(`  entries: ${packed.value.entryCount} files + manifest.json + install.ps1 + install.bat（双击向导）`);
console.log(`  安装：解压后双击 install.bat（零命令行）；或 powershell -ExecutionPolicy Bypass -File install.ps1 [-TargetDir <目录>]（-Uninstall 只删 journal 内文件）`);
