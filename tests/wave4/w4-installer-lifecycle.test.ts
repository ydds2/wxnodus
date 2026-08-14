// tests/wave4/w4-installer-lifecycle.test.ts — DX-04：安装器生命周期契约（candidate + closure + lifecycle 脚本）
// 冻结 candidate 校验 fail-closed；依赖闭包完整性（缺依赖绝不打包）；install.ps1 携带
// staging/postcondition/atomic switch/recover journal/uninstall 语义（只删 journal 内文件，不删外部 data）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateFrozenInstallerCandidate, type FrozenInstallerCandidate } from '../../src/application/release/installerCandidate.js';
import { collectDependencyClosure, scanDistImportSpecifiers, stageClosureEntries, verifyDependencyClosure } from '../../src/application/release/dependencyClosure.js';
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

  it('accepts subpath specifiers of closure packages (react/jsx-runtime, @scope/pkg/sub)', () => {
    // Gate H 实测暴露：dist 引入 react/jsx-runtime、@modelcontextprotocol/client/stdio 等
    // 子路径 specifier——包在闭包内即满足，不能要求 specifier 恰为包名
    const dir = tmp();
    mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'react', 'package.json'), JSON.stringify({ name: 'react', version: '19.2.0' }));
    mkdirSync(join(dir, 'node_modules', '@scope', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@scope', 'pkg', 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '1.0.0' }));
    const closure = collectDependencyClosure(join(dir, 'node_modules'), ['react', '@scope/pkg']);
    const check = verifyDependencyClosure(
      new Set(['react/jsx-runtime', '@scope/pkg/sub/path']),
      closure,
      [],
    );
    expect(check.ok).toBe(true);
    // 根包不在闭包的子路径 specifier 仍 fail-closed
    const missing = verifyDependencyClosure(new Set(['react-other/jsx']), closure, []);
    expect(missing.ok).toBe(false);
  });

  it('excludes type artifacts and sourcemaps from the runtime closure (MAX_PATH + bloat)', () => {
    // Gate H 实测暴露：@huggingface/transformers 的 types/**/*.d.ts.map 深度路径在
    // staging Copy-Item 时突破 MAX_PATH（260）；类型产物运行时永不加载 → 不入闭包
    const dir = tmp();
    mkdirSync(join(dir, 'node_modules', 'pkg-a'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }));
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'index.js'), 'module.exports = 1');
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'types.d.ts'), 'export {}');
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'types.d.ts.map'), '{}');
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'index.js.map'), '{}');
    writeFileSync(join(dir, 'node_modules', 'pkg-a', 'LICENSE'), 'MIT');
    const closure = collectDependencyClosure(join(dir, 'node_modules'), ['pkg-a']);
    expect(closure.files.has('pkg-a/index.js')).toBe(true);
    expect(closure.files.has('pkg-a/LICENSE')).toBe(true); // 合规红线：许可证保留
    expect(closure.files.has('pkg-a/types.d.ts')).toBe(false);
    expect(closure.files.has('pkg-a/types.d.ts.map')).toBe(false);
    expect(closure.files.has('pkg-a/index.js.map')).toBe(false);
  });

  it('stages closure entries under node_modules/ so the installed app can resolve deps', () => {
    // Gate H 实测暴露：闭包键缺 node_modules/ 前缀 → 安装器把依赖平铺到安装根目录，
    // 运行时 node_modules 解析必然失败。staged 树必须还原 node_modules/ 布局
    const staged = stageClosureEntries(new Map([['pkg-a/index.js', Buffer.from('x')]]));
    expect(staged.has('node_modules/pkg-a/index.js')).toBe(true);
    expect(staged.has('pkg-a/index.js')).toBe(false);
  });

  it('runtime build excludes src test files so vitest never leaks into the dist closure', () => {
    // Gate H 实测暴露：src/**/*.test.ts 被 tsc 编进 dist → vitest（devDependency）污染闭包。
    // 源检：基础 tsconfig 必须排除 src 测试文件（tests 型检走 tsconfig.tests.json，不受影响）
    const tsconfig = JSON.parse(readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf8')) as { exclude?: string[] };
    expect(tsconfig.exclude ?? []).toContain('src/**/*.test.ts');
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
    // 转义回归：PS 里路径分隔符必须是 '\'（TS 模板字面量 '\' 会被吞成 ''，曾致 journal dirs=0）
    expect(script).toContain("($f -replace '/', '\\').Split('\\')");
    expect(script).toContain("($parts[0..$i] -join '\\')");
  });
});
