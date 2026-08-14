// tests/wave4/w4-installer-lifecycle.test.ts — DX-04：安装器生命周期契约（candidate + closure + lifecycle 脚本）
// 冻结 candidate 校验 fail-closed；依赖闭包完整性（缺依赖绝不打包）；install.ps1 携带
// staging/postcondition/atomic switch/recover journal/uninstall 语义（只删 journal 内文件，不删外部 data）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateFrozenInstallerCandidate, type FrozenInstallerCandidate } from '../../src/application/release/installerCandidate.js';
import { collectDependencyClosure, scanDistImportSpecifiers, verifyDependencyClosure } from '../../src/application/release/dependencyClosure.js';
import { buildInstallerPackage } from '../../src/application/release/installerPackager.js';
import { readZip } from '../../src/application/release/zipArchive.js';
import { readFile } from 'node:fs/promises';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败静默 */ }
  }
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'w4-inst-'));
  tempDirs.push(d);
  return d;
};
const candidate = (overrides: Partial<FrozenInstallerCandidate> = {}): FrozenInstallerCandidate => ({
  candidateId: 'wxnodus-3.0.0-win-x64',
  commit: 'a'.repeat(40),
  tgzSha256: 'b'.repeat(64),
  cell: { os: 'win32', arch: 'x64', node: 'v22.18.0' },
  entrypoint: 'dist/cli/index.js',
  dynamicImportDeclarations: [],
  stagedTree: new Map([['dist/cli/index.js', Buffer.from('console.log(1)')]]),
  ...overrides,
});

describe('DX-04 frozen installer candidate', () => {
  it('accepts a well-formed frozen candidate', () => {
    const r = validateFrozenInstallerCandidate(candidate());
    expect(r.ok).toBe(true);
  });

  it.each([
    { patch: { candidateId: 'BAD SPACE' }, code: 'INSTALLER_CANDIDATE_ID_INVALID' },
    { patch: { commit: 'not-a-commit' }, code: 'INSTALLER_CANDIDATE_COMMIT_INVALID' },
    { patch: { tgzSha256: 'xyz' }, code: 'INSTALLER_CANDIDATE_TGZ_INVALID' },
    { patch: { cell: { os: 'win32', arch: 'x64', node: 'nope' } }, code: 'INSTALLER_CANDIDATE_CELL_INVALID' },
    { patch: { stagedTree: new Map() }, code: 'INSTALLER_CANDIDATE_TREE_EMPTY' },
    // entry 不在树内/非法 entry 均由路径策略先行拒绝（INSTALLER_ENTRY_INVALID fail-closed）
    { patch: { entrypoint: 'dist/missing.js' }, code: 'INSTALLER_ENTRY_INVALID' },
    { patch: { entrypoint: '../escape.js' }, code: 'INSTALLER_ENTRY_INVALID' },
  ] as Array<{ patch: Partial<FrozenInstallerCandidate>; code: string }>)('rejects $code fail-closed', ({ patch, code }) => {
    const r = validateFrozenInstallerCandidate(candidate(patch));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});

describe('DX-04 dependency closure', () => {
  it('collects the production closure from node_modules package.json dependencies', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'node_modules', 'pkg-a'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0', dependencies: { 'pkg-b': '^1.0.0' } }));
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'index.js'), 'module.exports = 1');
    mkdirSync(join(dir, 'node_modules', 'pkg-b'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg-b', 'package.json'), JSON.stringify({ name: 'pkg-b', version: '1.0.0' }));
    writeFileSync(join(dir, 'node_modules', 'pkg-b', 'index.js'), 'module.exports = 2');
    const closure = collectDependencyClosure(join(dir, 'node_modules'), ['pkg-a']);
    expect(closure.packages.has('pkg-a')).toBe(true);
    expect(closure.packages.has('pkg-b')).toBe(true);
    expect(closure.files.has('pkg-a/index.js')).toBe(true);
    expect(closure.files.has('pkg-b/index.js')).toBe(true);
  });

  it('fails closed on any bare specifier outside the closure (missing dependency never ships)', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'node_modules', 'pkg-a'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }));
    const closure = collectDependencyClosure(join(dir, 'node_modules'), ['pkg-a']);
    expect(closure.packages.has('pkg-a')).toBe(true);
    const check = verifyDependencyClosure(new Set(['pkg-a', 'totally-missing-dep']), closure, []);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.code).toBe('INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE');
    // 显式声明的动态 import 放行
    expect(verifyDependencyClosure(new Set(['pkg-a', 'runtime-assembled']), closure, ['runtime-assembled']).ok).toBe(true);
    // node: 内置不外查
    expect(verifyDependencyClosure(new Set(['pkg-a', 'node:fs']), closure, []).ok).toBe(true);
  });

  it('scans dist for static and literal dynamic import specifiers', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'a.js'), `import { x } from 'some-pkg';\nconst m = await import('another-pkg');\nimport './local.js';`);
    const specifiers = scanDistImportSpecifiers(join(dir, 'dist'));
    expect(specifiers.has('some-pkg')).toBe(true);
    expect(specifiers.has('another-pkg')).toBe(true);
    expect(specifiers.has('./local.js')).toBe(false);
  });
});

describe('DX-04 install.ps1 lifecycle', () => {
  it('generates an install script carrying staging/postcondition/switch/journal/uninstall semantics', async () => {
    const dir = tmp();
    const files = new Map<string, Buffer>([
      ['dist/cli/index.js', Buffer.from('console.log("ok")')],
      ['README.md', Buffer.from('readme')],
    ]);
    const packed = await buildInstallerPackage({ appName: 'wxnodus', version: '3.0.0', icon: null, entryPath: 'dist/cli/index.js', files, outDir: dir });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const zip = await readFile(packed.value.zipPath);
    const readBack = readZip(zip);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) return;
    const script = readBack.value.get('install.ps1')!.toString('utf8');
    // lifecycle 语义逐项在场（只删 journal 内文件——绝不删除外部 data）
    expect(script).toContain('INSTALLER_POSTCONDITION_FAILED');
    expect(script).toContain('INSTALLER_SWITCH_FAILED');
    expect(script).toContain('wxnodus-staging-');
    expect(script).toContain('wxnodus-backup-');
    expect(script).toContain('.wxnodus-journal.json');
    expect(script).toContain('INSTALLER_UNINSTALL_NO_JOURNAL');
    expect(script).toContain('-Uninstall');
    // journal 是唯一删除来源（绝不删除外部 data 的语义锚点）
    expect(script).toContain('$Owned.files');
    expect(script).toContain('$Owned.dirs');
    // manifest 全量 sha256 校验仍在（漂移即拒）
    expect(script).toContain('INSTALLER_SHA256_MISMATCH');
  });
});
