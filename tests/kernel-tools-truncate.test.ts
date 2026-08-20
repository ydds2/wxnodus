// tests/kernel-tools-truncate.test.ts — 工具结果诚实截断（fs_read 超长标注）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });

describe('fs_read 诚实截断', () => {
  it('超长文件截断并显式标注（模型知道有剩余）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-fsr-'));
    dirs.push(d);
    const big = '行'.repeat(21000);
    const f = join(d, 'big.txt');
    writeFileSync(f, big);
    const read = coreTools()['fs_read'];
    const out = await read!.run({ path: 'big.txt' }, { cwd: d } as any);
    expect(out).toContain('文件过长已截断');
    expect(out).toContain('21000');
    expect(out).toContain('剩余 1000 字');
  });

  it('短文件原样返回（无截断标注）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-fsr-'));
    dirs.push(d);
    writeFileSync(join(d, 'small.txt'), '短内容');
    const read = coreTools()['fs_read'];
    const out = await read!.run({ path: 'small.txt' }, { cwd: d } as any);
    expect(out).toBe('短内容');
  });
});

describe('fs_read 分页续读（offset/limit）', () => {
  it('按行切片 + 尾部行号标注（可 offset 续读）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-fsr-'));
    dirs.push(d);
    const lines = Array.from({ length: 10 }, (_, i) => `第${i}行`);
    writeFileSync(join(d, 'page.txt'), lines.join('\n'));
    const read = coreTools()['fs_read'];
    const out = await read!.run({ path: 'page.txt', offset: 3, limit: 3 }, { cwd: d } as any);
    expect(out).toContain('第3行');
    expect(out).toContain('第5行');
    expect(out).not.toContain('第2行');
    expect(out).toContain('offset=6 续读');
  });
  it('offset 超界 → 空内容不抛错；limit 负数按全文', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-fsr-'));
    dirs.push(d);
    writeFileSync(join(d, 't.txt'), 'a\nb\nc');
    const read = coreTools()['fs_read'];
    const out = await read!.run({ path: 't.txt', offset: 99 }, { cwd: d } as any);
    expect(out).toBe('');
  });
});

describe('ls head 截断', () => {
  it('超限条目截断并标注总数', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-ls-'));
    dirs.push(d);
    for (let i = 0; i < 10; i++) writeFileSync(join(d, `f${i}.txt`), 'x');
    const ls = coreTools()['ls'];
    const out = await ls!.run({ path: '.', head: 3 }, { cwd: d } as any);
    expect(out).toContain('f0.txt');
    expect(out).toContain('共 10 个条目');
    expect(out).not.toContain('f9.txt');
  });
});

describe('minIntervalSince 工具间隔护栏', () => {
  it('纯函数：间隔内返回等待值，间隔外 0', async () => {
    const { minIntervalSince } = await import('../src/kernel/tools.js');
    expect(minIntervalSince(1000, 1500, 2000)).toBe(500);
    expect(minIntervalSince(1000, 1500, 2600)).toBe(0);
    expect(minIntervalSince(0, 1500, 100)).toBe(1400);
  });
});
