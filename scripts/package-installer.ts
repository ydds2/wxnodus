// scripts/package-installer.ts — DX-04：安装器打包入口（只消费冻结 candidate，绝不猜 dist/cli）
// 用法：npm exec -- tsx scripts/package-installer.ts --candidate <candidate.json> --name <appName> --version <x.y.z> [--out <dir>] [--icon <text>]
//       [--sbom <sbom.json>] [--node24-binary <better_sqlite3.node>] [--node24-download]
// candidate.json（冻结）：{ candidateId, commit, tgzSha256, cell:{os,arch,node}, entrypoint, dynamicImportDeclarations: [] }
// 流程：validateFrozenInstallerCandidate → dist 树 + node_modules 生产依赖闭包（collectDependencyClosure）
//       → scanDistImportSpecifiers + verifyDependencyClosure（缺依赖 → INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE）
//       → buildInstallerPackage（manifest 全量 sha256 + 确定性 zip + 读回自校验）
// V4 C1（运行时兼容）：zip 默认携带打包机 ABI 的原生二进制（better-sqlite3 等 V8 ABI 模块）；
// --node24-binary <file> / --node24-download 提供 Node 24（ABI 137）侧车二进制——install.ps1 按
// 本机 ABI 三路裁决（默认 / 侧车替换 / 诚实拒绝）。气隙打包机用 --node24-binary 手工供料。
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildInstallerPackage } from '../src/application/release/installerPackager.js';
import type { NativeAbiSidecarInput } from '../src/application/release/installerPackager.js';
import { validateFrozenInstallerCandidate, type FrozenInstallerCandidate } from '../src/application/release/installerCandidate.js';
import { collectDependencyClosure, scanDistImportSpecifiers, stageClosureEntries, verifyDependencyClosure } from '../src/application/release/dependencyClosure.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);
const candidateFile = flag('--candidate');
const name = flag('--name');
const version = flag('--version');
const outDir = resolve(flag('--out') ?? 'dist-installer');
const icon = flag('--icon') ?? null;
const node24Binary = flag('--node24-binary');
const node24Download = hasFlag('--node24-download');

// V4 C1：Node 24 LTS 的 ABI（process.versions.modules = 137）——侧车目标版本常量
const NODE24_ABI = 137;
// 唯一 V8-ABI 原生依赖（robotjs/node-pty/node-screenshots 为 NAPI，sqlite-vec 为 SQLite 可加载扩展，
// 均跨 ABI 稳定——见 docs/eval-vs-competitors-2026-08-27.md 兼容性取证）
const BETTER_SQLITE3_NODE = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

/** 从 better-sqlite3 发布资产（WiseLibs/better-sqlite3）按 tag+名称解析并下载 ABI 137 预编译。 */
const downloadNode24Sidecar = async (bs3Version: string): Promise<Buffer> => {
  const assetName = `better-sqlite3-v${bs3Version}-node-v${NODE24_ABI}-win32-x64.tar.gz`;
  const apiBase = 'https://api.github.com/repos/WiseLibs/better-sqlite3';
  const headers = { 'User-Agent': 'wxnodus-pack', Accept: 'application/octet-stream' };
  // ① 解析资产 URL（release tag API）——直连 release CDN 在部分网络被重置，asset API 更稳
  let assets: Array<{ name?: string; url?: string }> = [];
  try {
    const listRes = await fetch(`${apiBase}/releases/tags/v${bs3Version}`, { headers: { 'User-Agent': headers['User-Agent'] } });
    if (!listRes.ok) throw new Error(`release tag API HTTP ${listRes.status}`);
    const body = await listRes.json() as { assets?: Array<{ name?: string; url?: string }> };
    assets = body.assets ?? [];
  } catch (cause) {
    throw new Error(`resolve release assets failed: ${String(cause)}`);
  }
  const asset = assets.find(a => a.name === assetName);
  if (!asset?.url) throw new Error(`asset not found: ${assetName}（better-sqlite3 ${bs3Version} 未发布 ABI ${NODE24_ABI} 预编译）`);
  // ② 下载 tar.gz
  const dl = await fetch(asset.url, { headers });
  if (!dl.ok) throw new Error(`asset download HTTP ${dl.status}`);
  const tarball = Buffer.from(await dl.arrayBuffer());
  // ③ tar.exe（Win10+ 内置 bsdtar）解出 build/Release/better_sqlite3.node
  const dir = mkdtempSync(join(tmpdir(), 'wxnodus-bs3-'));
  try {
    const tgzPath = join(dir, 'sidecar.tar.gz');
    writeFileSync(tgzPath, tarball);
    execFileSync('tar', ['-xzf', tgzPath, '-C', dir], { stdio: 'pipe' });
    const nodePath = join(dir, 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(nodePath)) throw new Error('extracted tree missing build/Release/better_sqlite3.node');
    return readFileSync(nodePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** 收集 ABI 侧车（Node 24）——返回清单与打包机 better-sqlite3 版本（供 SBOM 口径日志）。 */
const collectNativeAbiSidecars = async (): Promise<{ sidecars: NativeAbiSidecarInput[]; bs3Version: string }> => {
  const bs3Pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')) as { version?: string };
  const bs3Version = String(bs3Pkg.version ?? 'unknown');
  const sidecars: NativeAbiSidecarInput[] = [];
  if (!node24Binary && !node24Download) return { sidecars, bs3Version };
  if (Number(process.versions.modules) === NODE24_ABI) {
    console.warn('  native-abis: 打包机即 Node 24（ABI 137）——侧车冗余，跳过（默认二进制已覆盖）');
    return { sidecars, bs3Version };
  }
  if (node24Binary) {
    if (!existsSync(node24Binary)) {
      console.error(`NODE24_BINARY_MISSING: ${node24Binary}`);
      process.exit(2);
    }
    sidecars.push({ abi: NODE24_ABI, targetPath: BETTER_SQLITE3_NODE, bytes: readFileSync(node24Binary) });
    console.log(`  native-abis: ABI ${NODE24_ABI} sidecar from ${node24Binary}（sha256 ${createHash('sha256').update(sidecars[0]!.bytes).digest('hex')}）`);
    return { sidecars, bs3Version };
  }
  try {
    const bytes = await downloadNode24Sidecar(bs3Version);
    sidecars.push({ abi: NODE24_ABI, targetPath: BETTER_SQLITE3_NODE, bytes });
    console.log(`  native-abis: ABI ${NODE24_ABI} sidecar downloaded（better-sqlite3 ${bs3Version}，sha256 ${createHash('sha256').update(bytes).digest('hex')}）`);
  } catch (cause) {
    console.error(`NODE24_DOWNLOAD_FAILED: ${String(cause)}\n  气隙打包机请改用 --node24-binary <better_sqlite3.node>（ABI ${NODE24_ABI} 预编译）手工供料。`);
    process.exit(2);
  }
  return { sidecars, bs3Version };
};

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
// C-1（2026-08-30 止血）：hermes TUI 子进程入口停止随包分发——05274b34 用户裁决定型官方 ink 6
// 后，运行时零处解析 <安装根>/packages/hermes-tui/dist/entry.js（全仓 grep 仅陈旧注释），
// 此前强制携带 3.9MB 未运行 UI 且缺产物即打包失败（HERMES_TUI_DIST_MISSING 硬退出）属死重。
// P2-16（2026-08-27）：离线用户手册随包分发（气隙机器零网可查——npm run docs:user-guide 生成）
const userGuidePath = join(ROOT, 'docs', 'user-guide.md');
if (existsSync(userGuidePath)) {
  staged.set('docs/user-guide.md', readFileSync(userGuidePath));
} else {
  console.warn('  user-guide.md 缺失——先 npm run docs:user-guide（不阻断打包，仅无离线手册）');
}
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
staged.set('package.json', Buffer.from(JSON.stringify({ name, version, type: 'module', private: true }, null, 2) + '\n', 'utf8'));

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

// V4 C1：多 ABI 原生二进制侧车（Node 24）——zip 安装链与用户 Node 版本解耦
const nativeAbi = await collectNativeAbiSidecars();

const packed = await buildInstallerPackage({
  appName: name,
  version,
  icon,
  entryPath: candidate.entrypoint,
  files: staged,
  outDir,
  nativeAbis: nativeAbi.sidecars,
});
if (!packed.ok) {
  console.error(`PACKAGE_FAILED: ${packed.error.code}`);
  process.exit(1);
}
console.log(`PACKAGED: ${packed.value.zipPath}`);
console.log(`  candidate: ${candidate.candidateId} @ ${candidate.commit}`);
console.log(`  zipSha256: ${packed.value.zipSha256}`);
console.log(`  entries: ${packed.value.entryCount} files + manifest.json + install.ps1 + install.bat（双击向导）`);
console.log(`  nativeAbis: 默认 ABI ${packed.value.manifest.buildAbi}${packed.value.manifest.nativeAbis?.length ? ` + ${packed.value.manifest.nativeAbis.map(n => n.abi).join('+')} 侧车` : ''}（better-sqlite3 ${nativeAbi.bs3Version}）`);
console.log(`  安装：解压后双击 install.bat（零命令行）；或 powershell -ExecutionPolicy Bypass -File install.ps1 [-TargetDir <目录>]（-Uninstall 只删 journal 内文件）`);
