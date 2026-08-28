// tests/kernel-git-publish.test.ts — Git 发布流（数据主权修订 · 2026-08-28）
// 覆盖：remote 形态校验 / 初始化与既有仓库两路 / origin 绑定与换绑 / 无变更仍推 /
// 鉴权失败诚实回显 / 身份零污染（-c 注入）/ 真实 git 集成（本地 bare 仓库 round-trip）
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { remoteAllowed, publishDirToGit, type GitRunner } from '../src/kernel/gitPublish.js';

const mkRunner = () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const replies: Array<{ code: number; stdout: string; stderr: string }> = [];
  const runner: GitRunner = async (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    return replies.length > 1 ? replies.shift()! : (replies[0] ?? { code: 0, stdout: '', stderr: '' });
  };
  return { calls, replies, runner };
};

describe('remoteAllowed（remote 形态校验）', () => {
  it('http(s)/git@/ssh 恒可；空与其他形态默认拒绝、localRemote 显式放行', () => {
    expect(remoteAllowed('https://github.com/u/r.git', false)).toBe(true);
    expect(remoteAllowed('git@github.com:u/r.git', false)).toBe(true);
    expect(remoteAllowed('ssh://git@host/r', false)).toBe(true);
    expect(remoteAllowed('', false)).toBe(false);
    expect(remoteAllowed('file:///c:/x', false)).toBe(false);
    expect(remoteAllowed('C:/repos/r', false)).toBe(false);
    expect(remoteAllowed('file:///c:/x', true)).toBe(true);
    expect(remoteAllowed('C:/repos/r', true)).toBe(true);
  });
});

describe('publishDirToGit（注入 runner 的流程矩阵）', () => {
  it('目录不存在 → 诚实拒绝', async () => {
    const r = await publishDirToGit(join(tmpdir(), 'wxn-nope-xyz'), { remote: 'https://x.git' });
    expect(r.ok).toBe(false);
  });
  it('remote 未过校验 → 拒绝并说明 localRemote 通道', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wxn-gp-'));
    try {
      const r = await publishDirToGit(d, { remote: 'file:///x' });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain('local-remote');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('非仓库 → init + remote add + commit（身份经 -c 注入）+ push -u', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wxn-gp-'));
    try {
      const { calls, replies, runner } = mkRunner();
      // 依次：rev-parse(非仓) → init → remote get-url(无) → remote add → add -A → status(有变更) → commit → rev-parse → push
      Object.assign(replies, [
        { code: 128, stdout: '', stderr: 'not a git repository' },
        { code: 0, stdout: '', stderr: '' },
        { code: 1, stdout: '', stderr: 'no such remote' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: 'M file\n', stderr: '' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: 'abc1234', stderr: '' },
        { code: 0, stdout: '', stderr: '' },
      ]);
      const r = await publishDirToGit(d, { remote: 'https://github.com/u/r.git', message: 'm1', runner });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.initialized).toBe(true);
        expect(r.committed).toBe(true);
        expect(r.commit).toBe('abc1234');
      }
      const flat = calls.map(c => c.args.join(' '));
      expect(flat.some(a => a.startsWith('init -b main'))).toBe(true);
      expect(flat.some(a => a.includes('remote add origin https://github.com/u/r.git'))).toBe(true);
      expect(flat.some(a => a.includes('-c user.name=wxnodus-publish') && a.includes('commit -m m1'))).toBe(true); // 身份零污染
      expect(flat.some(a => a === 'push -u origin main')).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('既有仓库 remote 变更 → set-url；无变更 committed=false 仍推送', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wxn-gp-'));
    try {
      const { calls, replies, runner } = mkRunner();
      Object.assign(replies, [
        { code: 0, stdout: 'true', stderr: '' },          // rev-parse
        { code: 0, stdout: 'https://old.git', stderr: '' }, // get-url → 不同
        { code: 0, stdout: '', stderr: '' },               // set-url
        { code: 0, stdout: '', stderr: '' },               // add
        { code: 0, stdout: '', stderr: '' },               // status 空
        { code: 0, stdout: '', stderr: '' },               // push
      ]);
      const r = await publishDirToGit(d, { remote: 'https://new.git', branch: 'release', runner });
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.committed).toBe(false); expect(r.branch).toBe('release'); }
      expect(calls.some(c => c.args.join(' ').includes('remote set-url origin https://new.git'))).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('push 鉴权失败 → 诚实回显并附修复指引', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wxn-gp-'));
    try {
      const { replies, runner } = mkRunner();
      Object.assign(replies, [
        { code: 0, stdout: 'true', stderr: '' },
        { code: 0, stdout: 'https://OLD.git', stderr: '' },
        { code: 0, stdout: '', stderr: '' },  // set-url
        { code: 0, stdout: '', stderr: '' },  // add
        { code: 0, stdout: '', stderr: '' },  // status 空
        { code: 128, stdout: '', stderr: 'ERROR: Permission to u/r.git denied to user.' },
      ]);
      const r = await publishDirToGit(d, { remote: 'https://x.git', runner });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain('Personal Access Token');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('真实 git 集成（本地 bare 仓库 round-trip）', () => {
  it('发布→bare 收到提交与文件（localRemote 通道）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wxn-gp-real-'));
    const src = join(root, 'src');
    const bare = join(root, 'bare.git');
    try {
      mkdirSync(src);
      writeFileSync(join(src, 'bundle.json'), '{"name":"demo","version":"1.0.0"}', 'utf8');
      execFileSync('git', ['init', '--bare', '-b', 'main', bare], { windowsHide: true });
      const r = await publishDirToGit(src, { remote: bare, localRemote: true, message: 'real round-trip' });
      expect(r.ok).toBe(true);
      // bare 侧断言：main 存在且含 bundle.json
      const ls = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
      expect(ls).toContain('bundle.json');
      const log = execFileSync('git', ['-C', bare, 'log', '-1', '--format=%an %s', 'main'], { encoding: 'utf8' });
      expect(log).toContain('wxnodus-publish');
      expect(log).toContain('real round-trip');
      // 幂等二推：无变更 committed=false 仍 ok
      const r2 = await publishDirToGit(src, { remote: bare, localRemote: true, runner: undefined });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.committed).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
