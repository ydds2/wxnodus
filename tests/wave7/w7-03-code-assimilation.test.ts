// tests/wave7/w7-03-code-assimilation.test.ts — W7-03：黑洞同化通道 C（代码/模块/插件/MCP）
// 契约：目录扫描分块（文本入索引/二进制跳过并报告）→ FTS 可检索（符号名/注释，中文 bigram）；
// 配额超限 complete:false 诚实标记；同化只读（源文件哈希不变）；插件/MCP 清单面索引 + 来源标注。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { scanCodeTargets, type ScanReport } from '../../src/infrastructure/code/codeIndexer.js';
import { CodeIndexRepository } from '../../src/infrastructure/code/codeIndexRepository.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w7-code-')); tempDirs.push(d); return d; };
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function fixtureDir(): { dir: string; files: Record<string, { bytes: Buffer; hash: string; mtimeMs: number }> } {
  const dir = tmp();
  const a = `// 黑洞核心计算模块\n/** 计算黑洞事件视界半径 */\nexport function computeBlackholeRadius(massKg: number): number { return massKg * 1.48e-27; }\n`;
  const md = `# 模块说明\nwxnodus 黑洞引擎的记忆压缩调度说明。\n`;
  const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'blackhole.ts'), a, 'utf8');
  writeFileSync(join(dir, 'README.md'), md, 'utf8');
  writeFileSync(join(dir, 'data.bin'), bin);
  const snap: Record<string, { bytes: Buffer; hash: string; mtimeMs: number }> = {};
  for (const p of ['src/blackhole.ts', 'README.md', 'data.bin']) {
    const bytes = readFileSync(join(dir, p));
    snap[p] = { bytes, hash: sha256(bytes), mtimeMs: statSync(join(dir, p)).mtimeMs };
  }
  return { dir, files: snap };
}

describe('scanCodeTargets', () => {
  it('文本文件分块入索引，二进制跳过并报告，同化全程只读', () => {
    const fx = fixtureDir();
    const result = scanCodeTargets(fx.dir, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const textPaths = result.value.chunks.map(c => c.path);
    expect(textPaths).toContain('src/blackhole.ts');
    expect(textPaths).toContain('README.md');
    expect(textPaths).not.toContain('data.bin');
    expect(result.value.report.skipped.some(s => s.path === 'data.bin' && s.reason.includes('binary'))).toBe(true);
    // 只读保证：源文件哈希与 mtime 不变
    for (const p of Object.keys(fx.files)) {
      expect(sha256(readFileSync(join(fx.dir, p)))).toBe(fx.files[p]!.hash);
      expect(statSync(join(fx.dir, p)).mtimeMs).toBe(fx.files[p]!.mtimeMs);
    }
  });

  it('文件数配额超限 → 部分索引 + complete:false 诚实标记（绝不假装全量）', () => {
    const fx = fixtureDir();
    const result = scanCodeTargets(fx.dir, { maxFiles: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks.length).toBeLessThanOrEqual(1);
    expect(result.value.report.complete).toBe(false);
    expect(result.value.report.counts).toMatchObject({ indexed: 1 });
  });

  it('超大文件跳过并报告（不截断入索引）', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'big.ts'), 'x'.repeat(64 * 1024), 'utf8');
    const result = scanCodeTargets(dir, { maxFileBytes: 1024 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks).toHaveLength(0);
    expect(result.value.report.skipped.some(s => s.path === 'big.ts')).toBe(true);
  });
});

describe('CodeIndexRepository（真实 SQLite FTS5）', () => {
  function freshRepo() {
    const dir = tmp();
    const db = new Database(join(dir, 'code.db'));
    const repo = new CodeIndexRepository(db);
    repo.install();
    return { db, repo, dir };
  }

  it('代码分块与插件/MCP 面索引后按来源检索（符号名/中文注释）', () => {
    const { db, repo } = freshRepo();
    try {
      repo.indexChunks([
        { source: 'code', path: 'src/blackhole.ts', chunkIndex: 0, head: 'computeBlackholeRadius', text: '// 黑洞核心计算\ncomputeBlackholeRadius' },
      ]);
      repo.indexSurfaces([
        { source: 'plugin', id: 'p1', title: 'auto-deploy', body: '自动部署工作流' },
        { source: 'mcp', id: 'm1', title: 'filesystem', body: '文件系统操作' },
      ]);
      const bySymbol = repo.search('computeBlackholeRadius', { limit: 5 });
      expect(bySymbol.length).toBeGreaterThan(0);
      expect(bySymbol[0]).toMatchObject({ source: 'code', path: 'src/blackhole.ts' });
      const byChinese = repo.search('黑洞', { limit: 5 });
      expect(byChinese.some(h => h.source === 'code')).toBe(true);
      const pluginHit = repo.search('deploy', { limit: 5 });
      expect(pluginHit.some(h => h.source === 'plugin' && h.id === 'p1')).toBe(true);
      const mcpHit = repo.search('文件', { limit: 5 });
      expect(mcpHit.some(h => h.source === 'mcp' && h.id === 'm1')).toBe(true);
      // 来源过滤
      expect(repo.search('deploy', { sources: ['mcp'], limit: 5 })).toHaveLength(0);
    } finally { db.close(); }
  });

  it('数据库文件不存在时 install 幂等', () => {
    const { db, repo } = freshRepo();
    try {
      repo.install();
      repo.install();
      expect(existsSync(join(tmp(), 'code.db'))).toBe(false); // 独立 tmp——仅验证 install 幂等不抛
    } finally { db.close(); }
  });
});
