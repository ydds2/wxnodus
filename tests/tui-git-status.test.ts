// tests/tui-git-status.test.ts — 只读 git 分支探测（kimi 底栏分支徽标语义，2026-08-28）
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBranch } from '../src/presentation/tui/gitStatus.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-git-status-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('gitBranch（不 spawn git 的纯文件读取）', () => {
  it('非 git 工作区 → null（诚实降级）', () => {
    expect(gitBranch(dir)).toBeNull();
  });

  it('refs/heads 分支解析', () => {
    mkdirSync(join(dir, '.git', 'refs', 'heads', 'feature', 'x'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    expect(gitBranch(dir)).toBe('feature/x');
  });

  it('loose ref 缺失时 packed-refs 回退；均缺失仍返回分支名（诚实降级）', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/packed-branch\n');
    expect(gitBranch(dir)).toBe('packed-branch'); // packed 缺失 → 降级返回分支名
    writeFileSync(join(dir, '.git', 'packed-refs'), '# pack-refs with: peeled\n0123456789abcdef0123456789abcdef01234567 refs/heads/packed-branch\n');
    expect(gitBranch(dir)).toBe('packed-branch');
  });

  it('detached HEAD → 7 位短哈希', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'abcdef0123456789abcdef0123456789abcdef01\n');
    expect(gitBranch(dir)).toBe('abcdef0');
  });
});
