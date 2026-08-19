// tests/installer-packager.contract.test.ts — §10-4：完整安装器打包器（确定性 zip + install.ps1 全量 sha256 校验 + 真实安装/拒装）
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(manifest.schemaVersion).toBe(2);
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
    const bat = readFileSync(join(unpackDir, 'install.bat'), 'utf8');
    expect(bat).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File');
    expect(bat).toContain('pause');
  });

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
