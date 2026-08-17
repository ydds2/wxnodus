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
