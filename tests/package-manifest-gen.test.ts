// tests/package-manifest-gen.test.ts — winget/scoop manifest 渲染纯函数（分发闭环 S0）
// 诚实门禁契约：url/sha256 缺失时输出 __*_REQUIRED__ 占位符（绝不生成假装可发布的 manifest）；
// 齐全时占位符全部消除。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWingetManifest, renderScoopManifest, zipSha256 } from '../src/application/release/manifestGen.js';

const WINGET_TPL = 'PackageVersion: __VERSION__\nShortDescription: __DESCRIPTION__\nInstallerUrl: __INSTALLER_URL__\nInstallerSha256: __INSTALLER_SHA256__\n';
const SCOOP_TPL = JSON.stringify({ version: '__VERSION__', description: '__DESCRIPTION__', homepage: '__HOMEPAGE__', url: '__INSTALLER_URL__', hash: '__INSTALLER_SHA256__' });
const PKG_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });

describe('renderWingetManifest', () => {
  it('url+sha256 齐全 → 无占位符残留', () => {
    const out = renderWingetManifest(WINGET_TPL, { version: '3.1.0', description: '测试', url: 'https://x/w.zip', sha256: 'abc' });
    expect(out).toContain('PackageVersion: 3.1.0');
    expect(out).toContain('https://x/w.zip');
    expect(out).not.toContain('__');
  });

  it('缺 url/sha256 → 明确占位符（不可发布态）', () => {
    const out = renderWingetManifest(WINGET_TPL, { version: '3.1.0', description: '测试' });
    expect(out).toContain('__RELEASE_URL_REQUIRED__');
    expect(out).toContain('__SHA256_REQUIRED__');
  });
});

describe('renderScoopManifest', () => {
  it('渲染后仍是合法 JSON 且版本替换', () => {
    const out = renderScoopManifest(SCOOP_TPL, { version: '3.1.0', description: '测试', url: 'https://x/w.zip', sha256: 'abc' });
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe('3.1.0');
    expect(parsed.url).toBe('https://x/w.zip');
    expect(parsed.hash).toBe('abc');
  });

  it('缺 hash → __SHA256_REQUIRED__（JSON 仍合法）', () => {
    const out = renderScoopManifest(SCOOP_TPL, { version: '3.1.0', description: '测试' });
    expect(JSON.parse(out).hash).toBe('__SHA256_REQUIRED__');
  });
});

describe('winget 多文件 manifest（winget-pkgs 发布形态）', () => {
  const complete = { version: '4.0.0-rc.1', description: '测试描述', url: 'https://x/w.zip', sha256: 'a'.repeat(64) };
  const required: Record<string, string[]> = {
    'version.template.yaml': ['PackageIdentifier: yyds2.wxnodus', 'PackageVersion: __VERSION__', 'DefaultLocale: zh-CN', 'ManifestType: version', 'ManifestVersion: 1.6.0'],
    'installer.template.yaml': ['InstallerType: portable', 'InstallerUrl: __INSTALLER_URL__', 'InstallerSha256: __INSTALLER_SHA256__', 'Commands:', 'ManifestType: installer'],
    'locale.zh-CN.template.yaml': ['PackageLocale: zh-CN', 'Publisher: yyds2', 'PackageName: WxNodus', 'License: Apache-2.0', 'ShortDescription: __DESCRIPTION__', 'ManifestType: defaultLocale'],
  };
  it('三份模板含发布必填字段；ctx 齐全时渲染无占位符残留', () => {
    for (const [file, musts] of Object.entries(required)) {
      const tpl = readFileSync(join(PKG_ROOT, 'packaging', 'winget', file), 'utf8');
      for (const m of musts) expect(tpl).toContain(m);
      const out = renderWingetManifest(tpl, complete);
      expect(out).not.toContain('__');
      expect(out).toContain('4.0.0-rc.1');
      if (file === 'installer.template.yaml') expect(out).toContain('https://x/w.zip');
      if (file === 'locale.zh-CN.template.yaml') expect(out).toContain('测试描述');
    }
  });
  it('scoop 模板 license 为 Apache-2.0（与 package.json 一致）', () => {
    const tpl = readFileSync(join(PKG_ROOT, 'packaging', 'scoop', 'wxnodus.template.json'), 'utf8');
    const out = JSON.parse(renderScoopManifest(tpl, complete));
    expect(out.license).toBe('Apache-2.0');
    expect(out.version).toBe('4.0.0-rc.1');
    expect(out.architecture['64bit'].url).toBe('https://x/w.zip');
    expect(out.architecture['64bit'].hash).toBe('a'.repeat(64));
  });
});

describe('zipSha256', () => {
  it('真实文件 → 64 位 hex；缺失文件 → null', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-sha-'));
    dirs.push(d);
    const f = join(d, 'a.zip');
    writeFileSync(f, 'hello');
    expect(zipSha256(f)).toMatch(/^[0-9a-f]{64}$/);
    expect(zipSha256(join(d, 'missing.zip'))).toBeNull();
  });
});
