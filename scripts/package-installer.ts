// scripts/package-installer.ts — DX-04：安装器打包入口（只消费冻结 candidate，绝不猜 dist/cli）
// 用法：npm exec -- tsx scripts/package-installer.ts --candidate <candidate.json> --name <appName> --version <x.y.z> [--out <dir>] [--icon <text>]
// candidate.json（冻结）：{ candidateId, commit, tgzSha256, cell:{os,arch,node}, entrypoint, dynamicImportDeclarations: [] }
// 流程：validateFrozenInstallerCandidate → dist 树 + node_modules 生产依赖闭包（collectDependencyClosure）
//       → scanDistImportSpecifiers + verifyDependencyClosure（缺依赖 → INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE）
//       → buildInstallerPackage（manifest 全量 sha256 + 确定性 zip + 读回自校验）
import { createHash } from 'node:crypto';
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
// V4 P3-5（a）：SBOM 闭包版本断言——freeze 时 SBOM（components+versions）与打包时实际
// node_modules 闭包比对（freeze→package 之间任何 npm install 造成的 semver 内漂移即拒——
// 此前依赖部分零绑定：candidate.json 只绑定 dist 哈希）
const sbomPath = flag('--sbom');
if (sbomPath) {
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8')) as { components?: Array<{ name: string; version: string }> };
  const sbomVersions = new Map((sbom.components ?? []).map(c => [c.name, c.version]));
  let drift = 0;
  for (const relPath of closure.files.keys()) {
    // relPath 形如 node_modules/<name>/... 或 node_modules/@scope/<name>/...
    const m = /node_modules\/(?:@[^/]+\/)?([^/]+)/.exec(relPath);
    if (!m) continue;
    const pkgName = m[1]!;
    const depPkgPath = join(ROOT, 'node_modules', relPath.slice('node_modules/'.length));
    try {
      const depPkg = JSON.parse(readFileSync(join(depPkgPath, 'package.json'), 'utf8')) as { name?: string; version?: string };
      const expected = depPkg.name ? sbomVersions.get(depPkg.name) : undefined;
      if (expected && depPkg.version !== expected) {
        console.error(`SBOM_DRIFT: ${depPkg.name} ${depPkg.version} != frozen ${expected}`);
        drift++;
      }
    } catch { /* 无 package.json 的子树跳过 */ }
  }
  if (drift > 0) { console.error(`CANDIDATE_SBOM_DRIFT: ${drift} dependencies differ from frozen SBOM`); process.exit(2); }
  // ABI 比对：better-sqlite3/robotjs 原生模块按打包机 Node ABI 编译——manifest 记录
  // process.versions.modules，install.ps1 预检比对（ABI 不匹配即 NODE_MODULE_VERSION 崩）
  console.log(`  ABI check: node ${process.version} (modules ABI ${process.versions.modules})`);
}

// V4 P3-5（b）：合成最小根 package.json（name/version/type:module）——tsc 只编译 src、staged 树
// 从无 package.json：kernel/version.ts 运行时读不到即回退 '0.0.0'（安装版 --version/banner/
// MCP/serve 全 0.0.0）；且缺 "type":"module" 时 Node <22.7 按 CJS 解析 ESM 直接 SyntaxError
// （install.ps1 预检已同步改 22.7 硬门槛，双保险）
staged.set('package.json', Buffer.from(JSON.stringify({ name, version, type: 'module', private: true }, null, 2) + '
', 'utf8'));

const distDigest = createHash('sha256');
for (const [path, bytes] of [...staged.entries()].filter(([path]) => path.startsWith('dist/')).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
  distDigest.update(path.slice('dist/'.length)).update('\0').update(bytes).update('\n');
}
if (typeof (raw as FrozenInstallerCandidate & { distTreeSha256?: unknown }).distTreeSha256 === 'string' &&
    distDigest.digest('hex') !== (raw as FrozenInstallerCandidate & { distTreeSha256: string }).distTreeSha256) {
  console.error('CANDIDATE_DIST_DRIFT: dist tree differs from frozen candidate');
  process.exit(2);
}
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
