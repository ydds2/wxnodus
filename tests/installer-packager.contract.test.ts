// tests/installer-packager.contract.test.ts — §10-4：完整安装器打包器（确定性 zip + install.ps1 全量 sha256 校验 + 真实安装/拒装）
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInstallerPackage } from '../src/application/release/installerPackager.js';
import { buildZip, readZip } from '../src/application/release/zipArchive.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wxnodus-pkg-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fixtureFiles = (): Map<string, Buffer> => new Map([
  ['bin/wxnodus.js', Buffer.from('#!/usr/bin/env node\nconsole.log("wxnodus-art")\n')],
  ['lib/util.js', Buffer.from('module.exports = 42;\n')],
  ['README.md', Buffer.from('# 我的工坊\n')],
]);

const extract = (zip: Buffer, dir: string): void => {
  const entries = readZip(zip);
  if (!entries.ok) throw new Error('readZip failed');
  for (const [path, content] of entries.value) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
};

const runInstaller = (scriptPath: string, targetDir: string, extraArgs: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TargetDir', targetDir, ...extraArgs],
      { timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ code: error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : (error ? 1 : 0), stdout, stderr });
      });
  });

describe('安装器打包器（完整集成）', () => {
  it('打包 → 读回逐字节还原；manifest 全量 sha256 绑定；zip 确定性（两次打包字节一致）', async () => {
    const first = await buildInstallerPackage({
      appName: '我的工坊/Pro*版', version: '4.0.0', icon: '🛠️', entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(existsSync(first.value.zipPath)).toBe(true);
    expect(first.value.manifest.appName).toBe('我的工坊Pro版');
    expect(first.value.entryCount).toBe(3);
    const zip = readFileSync(first.value.zipPath);
    const entries = readZip(zip);
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    expect(entries.value.size).toBe(6); // manifest.json + install.ps1 + install.bat + 3 文件
    for (const [path, content] of fixtureFiles()) {
      expect(entries.value.get(path)?.equals(content)).toBe(true);
    }
    const manifest = JSON.parse(entries.value.get('manifest.json')!.toString('utf8'));
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.entryPath).toBe('bin/wxnodus.js');
    expect(manifest.entrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files).toHaveLength(3);
    // 确定性：同输入两次打包字节一致
    const second = await buildInstallerPackage({
      appName: '我的工坊/Pro*版', version: '4.0.0', icon: '🛠️', entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.zipSha256).toBe(first.value.zipSha256);
  });

  it('非法输入确定性拒绝：缺入口 / 坏版本 / 纯非法名称 / 危险 zip 路径', async () => {
    const noEntry = await buildInstallerPackage({ appName: 'x', version: '4.0.0', icon: null, entryPath: 'bin/missing.js', files: fixtureFiles(), outDir: root });
    expect(noEntry).toMatchObject({ ok: false, error: { code: 'INSTALLER_ENTRY_INVALID' } });
    const badVersion = await buildInstallerPackage({ appName: 'x', version: '4.0', icon: null, entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root });
    expect(badVersion).toMatchObject({ ok: false, error: { code: 'INSTALLER_VERSION_INVALID' } });
    const badName = await buildInstallerPackage({ appName: '<>:"/\\|?*', version: '4.0.0', icon: null, entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root });
    expect(badName).toMatchObject({ ok: false, error: { code: 'INSTALLER_NAME_INVALID' } });
    expect(() => buildZip([{ path: '../evil.js', content: Buffer.from('x') }])).toThrow('ZIP_PATH_UNSAFE');
    expect(() => buildZip([{ path: 'C:/abs.js', content: Buffer.from('x') }])).toThrow('ZIP_PATH_UNSAFE');
  });
});

describe.skipIf(process.platform !== 'win32')('install.ps1 真实安装（Windows PowerShell）', () => {
  it('解包目录中执行 install.ps1：全量校验通过 → 安装到目标目录 + <appName>.cmd + install-meta', async () => {
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: '🛠️', entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpackDir = join(root, 'unpacked');
    mkdirSync(unpackDir, { recursive: true });
    extract(readFileSync(packed.value.zipPath), unpackDir);
    const target = join(root, 'installed');
    // -SkipPath：CI/测试不污染用户 PATH（PATH 注册为交互安装默认行为）
    const result = await runInstaller(join(unpackDir, 'install.ps1'), target, ['-SkipPath']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`INSTALLED: ${target}`);
    expect(existsSync(join(target, 'bin', 'wxnodus.js'))).toBe(true);
    expect(readFileSync(join(target, 'bin', 'wxnodus.js'), 'utf8')).toBe(fixtureFiles().get('bin/wxnodus.js')!.toString('utf8'));
    // 命令名 = 清洗后 appName（大小写保留）；内容注入数据目录并转发参数
    const cmd = readFileSync(join(target, 'WxNodusArt.cmd'), 'utf8');
    expect(cmd).toContain('node "%~dp0bin\\wxnodus.js"');
    expect(cmd).toContain('WXNODUS_DATA_DIR=%LOCALAPPDATA%\\wxnodus');
    expect(existsSync(join(target, 'start.cmd'))).toBe(false);
    // wxn 别名：winget/scoop manifest 声明的双命令契约（终审修复——安装器必须真实产出）
    expect(readFileSync(join(target, 'wxn.cmd'), 'utf8')).toContain('node "%~dp0bin\\wxnodus.js"');
    // install-meta：供 /update 识别 zip 渠道
    const meta = JSON.parse(readFileSync(join(target, 'install-meta.json'), 'utf8'));
    expect(meta).toMatchObject({ app: 'WxNodusArt', version: '1.2.3' });
  }, 60_000);

  it('生成脚本含 Node 预检 / PATH 注册 / install.bat 双击向导', async () => {
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: null, entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpackDir = join(root, 'unpacked');
    mkdirSync(unpackDir, { recursive: true });
    extract(readFileSync(packed.value.zipPath), unpackDir);
    const script = readFileSync(join(unpackDir, 'install.ps1'), 'utf8');
    expect(script).toContain('INSTALLER_NODE_MISSING');
    expect(script).toContain('https://nodejs.org/');
    expect(script).toContain('https://npmmirror.com/mirrors/node/');
    expect(script).toContain('PATH_UPDATED');
    expect(script).toContain('SkipPath');
    expect(script).toContain('REINSTALL_SAME_VERSION');
    expect(script).toContain('install-meta.json');
    expect(script).toContain('/XD $RobocopyExclude'); // robocopy 源树内目标自拷贝防护（残留回归锁定）
    expect(script).toContain('$RobocopyExclude += $TargetDir');
    const bat = readFileSync(join(unpackDir, 'install.bat'), 'utf8');
    expect(bat).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File');
    expect(bat).toContain('pause');
  });

  // V4 C1：真实 PowerShell 端到端——篡改 manifest buildAbi 制造 ABI 失配，驱动侧车/拒绝两条分支
  it('ABI 失配 + 侧车命中 → sha256 校验后替换安装、native-abis 辅助目录不落安装树', async () => {
    const sidecarBytes = Buffer.from('sidecar-binary-abi-local');
    const targetPath = 'bin/native.node';
    const files = new Map(fixtureFiles());
    files.set(targetPath, Buffer.from('default-abi-binary'));
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: null, entryPath: 'bin/wxnodus.js', files, outDir: root,
      nativeAbis: [{ abi: Number(process.versions.modules), targetPath, bytes: sidecarBytes }],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpackDir = join(root, 'unpacked-sidecar');
    mkdirSync(unpackDir, { recursive: true });
    extract(readFileSync(packed.value.zipPath), unpackDir);
    // 篡改 manifest buildAbi（install.ps1 不校验 manifest.json 自身）→ 制造「本机 ABI ≠ 打包 ABI」
    const manifestPath = join(unpackDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { buildAbi?: number };
    manifest.buildAbi = 99999;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const target = join(root, 'installed-sidecar');
    const result = await runInstaller(join(unpackDir, 'install.ps1'), target, ['-SkipPath']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ABI mismatch');
    expect(result.stdout).toContain('NATIVE_ABI_SIDECAR_APPLIED');
    // 安装树内为目标二进制为侧车字节；辅助目录绝不落盘
    expect(readFileSync(join(target, targetPath)).equals(sidecarBytes)).toBe(true);
    expect(existsSync(join(target, 'native-abis'))).toBe(false);
  }, 60_000);

  it('ABI 失配且无侧车 → INSTALLER_ABI_UNSUPPORTED 诚实拒绝，绝不带病安装', async () => {
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: null, entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpackDir = join(root, 'unpacked-nosidecar');
    mkdirSync(unpackDir, { recursive: true });
    extract(readFileSync(packed.value.zipPath), unpackDir);
    const manifestPath = join(unpackDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { buildAbi?: number };
    manifest.buildAbi = 99999;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const target = join(root, 'installed-nosidecar');
    const result = await runInstaller(join(unpackDir, 'install.ps1'), target, ['-SkipPath']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('INSTALLER_ABI_UNSUPPORTED');
    expect(existsSync(join(target, 'bin', 'wxnodus.js'))).toBe(false);
  }, 60_000);

  // 2026-08-28 发布链冒烟回归：TargetDir 位于解包目录内 → staging/backup 落入 robocopy 源树。
  // 曾实测：robocopy 把空 staging 目录拷进自身（卸载后残留）、reinstall 把旧安装树整体拷进新树。
  it('TargetDir 在源树内：/XD 防护生效——安装无 staging 残留、reinstall 无旧树嵌套、卸载清净', async () => {
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: null, entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpackDir = join(root, 'unpacked-inner');
    mkdirSync(unpackDir, { recursive: true });
    extract(readFileSync(packed.value.zipPath), unpackDir);
    const target = join(unpackDir, 'app'); // staging 落在 unpackDir（源树）内
    const script = join(unpackDir, 'install.ps1');

    // ① 首装：无 staging 自拷贝残留
    const first = await runInstaller(script, target, ['-SkipPath']);
    expect(first.code).toBe(0);
    expect(readFileSync(join(target, 'bin', 'wxnodus.js'), 'utf8')).toContain('wxnodus-art');
    expect(readdirSync(target).filter(n => n.startsWith('.wxnodus-staging'))).toEqual([]);

    // ② 卸载：只删 journal 内文件，用户自留文件保留，安装器残留归零
    writeFileSync(join(target, 'user-note.txt'), 'user data'); // 安装目录内的用户自留文件（不被 journal 管）
    const un = await runInstaller(script, target, ['-SkipPath', '-Uninstall']);
    expect(un.code).toBe(0);
    expect(un.stdout).toContain(`UNINSTALLED: ${target}`);
    expect(existsSync(join(target, 'bin', 'wxnodus.js'))).toBe(false);
    expect(existsSync(join(target, 'user-note.txt'))).toBe(true); // journal 语义：非自有文件绝不删
    expect(readdirSync(target).filter(n => n.startsWith('.wxnodus-'))).toEqual([]);

    // ③ reinstall（旧树在源树内）：无旧树嵌套、无 backup 残留（安装目录为应用自有，整体替换属契约内）
    const second = await runInstaller(script, target, ['-SkipPath']);
    expect(second.code).toBe(0);
    const top = readdirSync(target);
    expect(top.filter(n => n.startsWith('.wxnodus-staging') || n.startsWith('.wxnodus-backup'))).toEqual([]);
    expect(existsSync(join(target, 'app'))).toBe(false); // 旧树不得嵌套进新树
    expect(readdirSync(unpackDir).filter(n => n.startsWith('.wxnodus-'))).toEqual([]); // 源树无任何安装器残留
    expect(readFileSync(join(target, 'bin', 'wxnodus.js'), 'utf8')).toContain('wxnodus-art');
  }, 90_000);

  it('入口字节漂移（传输中篡改）→ install.ps1 校验失败 exit 1，拒绝带病安装', async () => {
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: null, entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    // 篡改模拟：manifest 保持原样，但入口文件内容被替换 → 重打包（等价于攻击者替换包内文件）
    const tamperedFiles = new Map(fixtureFiles());
    tamperedFiles.set('bin/wxnodus.js', Buffer.from('#!/usr/bin/env node\nconsole.log("evil")\n'));
    const tamperedZip = buildZip([
      { path: 'manifest.json', content: Buffer.from(JSON.stringify(packed.value.manifest, null, 2) + '\n', 'utf8') },
      { path: 'install.ps1', content: Buffer.from('') }, // 占位（不会被执行到）
      { path: 'bin/wxnodus.js', content: tamperedFiles.get('bin/wxnodus.js')! },
      { path: 'lib/util.js', content: fixtureFiles().get('lib/util.js')! },
      { path: 'README.md', content: fixtureFiles().get('README.md')! },
    ]);
    // 用原装 install.ps1（来自未篡改包）执行校验
    const goodUnpack = join(root, 'good');
    mkdirSync(goodUnpack, { recursive: true });
    extract(readFileSync(packed.value.zipPath), goodUnpack);
    const badUnpack = join(root, 'bad');
    mkdirSync(badUnpack, { recursive: true });
    extract(tamperedZip, badUnpack);
    const script = join(goodUnpack, 'install.ps1');
    // 把篡改后的 manifest+文件目录替换为坏文件（脚本目录指向坏目录）
    const badScript = join(badUnpack, 'install.ps1');
    writeFileSync(badScript, readFileSync(script));
    const target = join(root, 'installed-tampered');
    const result = await runInstaller(badScript, target);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('INSTALLER_SHA256_MISMATCH');
    expect(existsSync(join(target, 'bin', 'wxnodus.js'))).toBe(false); // 绝不带病安装
  }, 60_000);
});

// V4 P3-5：发布链闭环——合成根 package.json / Node 22.7 硬门槛 / manifest buildAbi
// V4 C1：多 ABI 原生侧车——install.ps1 三路裁决（默认 / 侧车替换 / 诚实拒绝）
describe('V4 P3-5 发布链闭环', () => {
  it('manifest 携带 buildAbi（当前进程 ABI）+ ps1 含 22.7 硬门槛与 ABI 比对', async () => {
    const files = new Map([['dist/cli/index.js', Buffer.from('console.log(1)')]]);
    const r = await buildInstallerPackage({ appName: 'wxnodus', version: '4.0.0', icon: null, entryPath: 'dist/cli/index.js', files, outDir: root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const manifest = r.value.manifest; // 直接返回 manifest 对象（zip 落盘产物）
    expect(manifest.buildAbi).toBe(Number(process.versions.modules));
    expect(manifest.nativeAbis).toEqual([]); // 无侧车输入 → 空清单
    // ps1 从 zip 提取验证——zipPath 落盘；用 manifestSha256 之外的直接读 packager 内嵌……
    // 简化：直接验证 ps1 模板行为经 install-one.e2e（真实安装）覆盖，此处断言 manifest 契约
    const fs = await import('node:fs');
    const zipBytes = fs.readFileSync(r.value.zipPath);
    const extractDir = join(root, 'unz');
    fs.mkdirSync(extractDir, { recursive: true });
    extract(zipBytes, extractDir);
    const ps1 = fs.readFileSync(join(extractDir, 'install.ps1'), 'utf8');
    expect(ps1).toContain('ABI mismatch');          // ABI 比对
    expect(ps1).toContain('-ge 7');                 // 22.7 硬门槛
    expect(ps1).toContain('buildAbi');              // manifest 字段读取
    expect(ps1).not.toContain('-ge 18)');           // 旧 18 门槛已废
    // V4 C1：三路裁决在场（侧车查找 / 诚实拒绝 / 应用后清理）
    expect(ps1).toContain('nativeAbis');
    expect(ps1).toContain('INSTALLER_ABI_UNSUPPORTED');
    expect(ps1).toContain('NATIVE_ABI_SIDECAR_APPLIED');
    expect(ps1).toContain('INSTALLER_NATIVE_SIDECAR_SHA256_MISMATCH');
    expect(ps1).toContain("'native-abis'");
  });

  it('V4 C1：nativeAbis 侧车入包——manifest 记录 sha256 绑定 + zip 含 native-abis/<abi>/ 文件 + 确定性保持', async () => {
    const sidecarBytes = Buffer.from('fake-better-sqlite3-node-binary');
    const targetPath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
    const input = {
      appName: 'wxnodus', version: '4.0.0', icon: null,
      entryPath: 'dist/cli/index.js',
      files: new Map([['dist/cli/index.js', Buffer.from('console.log(1)')]]),
      outDir: root,
      nativeAbis: [{ abi: 137, targetPath, bytes: sidecarBytes }],
    };
    const first = await buildInstallerPackage(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.manifest.schemaVersion).toBe(3);
    const na = first.value.manifest.nativeAbis ?? [];
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({ abi: 137, path: targetPath, bytes: sidecarBytes.length });
    expect(na[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    const zipBytes = readFileSync(first.value.zipPath);
    const entries = readZip(zipBytes);
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    expect(entries.value.get(`native-abis/137/${targetPath}`)?.equals(sidecarBytes)).toBe(true);
    // 确定性：含侧车输入两次打包字节一致
    const second = await buildInstallerPackage(input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.zipSha256).toBe(first.value.zipSha256);
    // 非法 ABI / 空二进制 fail-closed
    const badAbi = await buildInstallerPackage({ ...input, nativeAbis: [{ abi: -1, targetPath, bytes: sidecarBytes }] });
    expect(badAbi).toMatchObject({ ok: false, error: { code: 'INSTALLER_NATIVE_ABI_INVALID' } });
    const badBytes = await buildInstallerPackage({ ...input, nativeAbis: [{ abi: 137, targetPath, bytes: Buffer.alloc(0) }] });
    expect(badBytes).toMatchObject({ ok: false, error: { code: 'INSTALLER_NATIVE_ABI_INVALID' } });
    // 侧车路径越界 fail-closed（沿用路径策略）
    const badPath = await buildInstallerPackage({ ...input, nativeAbis: [{ abi: 137, targetPath: '../escape.node', bytes: sidecarBytes }] });
    expect(badPath).toMatchObject({ ok: false, error: { code: 'INSTALLER_PATH_INVALID' } });
  });
});
