// packages/vscode-ext/tests/gitDiff.test.mjs — P2-12（2026-08-27）：工作区 diff 收集（零 vscode 依赖）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

// gitDiff 是 TS（类型擦除后零运行时依赖）——esbuild 单文件转译后 require（wireBridge 同款模式）
const tmpBundle = mkdtempSync(join(tmpdir(), 'wxn-ext-gitdiff-'));
const { collectWorkspaceDiff } = createRequire(import.meta.url)((() => {
  const out = buildSync({
    entryPoints: ['src/gitDiff.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  writeFileSync(join(tmpBundle, 'gitDiff.cjs'), out);
  return join(tmpBundle, 'gitDiff.cjs');
})());

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('git 仓库：HEAD 后有改动 → 返回按文件拆分且带 + 行的 diff', { skip: !hasGit }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-vs-git-'));
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'a.txt'), 'line1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'a.txt'), 'line1\nline2\n');
    const r = await collectWorkspaceDiff(dir);
    assert.ok(!('unavailable' in r), '应为可用 diff');
    assert.ok(r.files.some(f => f.file === 'a.txt'), '应包含 a.txt');
    assert.ok(r.files.find(f => f.file === 'a.txt').diff.includes('+line2'), '应含新增行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非 git 仓库 → unavailable（诚实降级，绝不假装有 diff）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-vs-nogit-'));
  try {
    writeFileSync(join(dir, 'x.txt'), 'x');
    const r = await collectWorkspaceDiff(dir);
    assert.ok('unavailable' in r, '应 unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 仓库无改动 → unavailable（本轮无文件改动）', { skip: !hasGit }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-vs-clean-'));
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'a.txt'), 'x');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
    const r = await collectWorkspaceDiff(dir);
    assert.ok('unavailable' in r, '无改动应 unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
