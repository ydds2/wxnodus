// tests/kernel-sys-package.test.ts — Windows 包管理器自适应（sys_package · 2026-08-28）
import { describe, it, expect, beforeEach } from 'vitest';
import { detectPackageManager, buildInstallArgs, buildSearchArgs, searchPackages, installPackage, resetPkgManagerCacheForTests, type SysRunner } from '../src/kernel/sysPackage.js';

beforeEach(() => { resetPkgManagerCacheForTests(); });

const fakeOk = (bin: string): SysRunner => async (b) => (b === bin ? { code: 0, stdout: `${bin} 1.0`, stderr: '' } : { code: -1, stdout: '', stderr: `ENOENT ${b}` });

describe('detectPackageManager（自适应探测）', () => {
  it('仅 winget 可用 → winget', async () => {
    expect(await detectPackageManager(undefined, fakeOk('winget'))).toBe('winget');
  });
  it('仅 scoop 可用 → scoop（跳过不可用的 winget）', async () => {
    expect(await detectPackageManager(undefined, fakeOk('scoop'))).toBe('scoop');
  });
  it('仅 choco 可用 → choco', async () => {
    expect(await detectPackageManager(undefined, fakeOk('choco'))).toBe('choco');
  });
  it('全无 → null（诚实空）', async () => {
    expect(await detectPackageManager(undefined, async () => ({ code: -1, stdout: '', stderr: 'x' }))).toBeNull();
  });
  it('显式 manager：不支持的 → 报错；不可用 → 诚实报装法', async () => {
    await expect(detectPackageManager('apt', fakeOk('winget'))).rejects.toThrow(/不支持的 manager/);
    await expect(detectPackageManager('scoop', fakeOk('winget'))).rejects.toThrow(/scoop 不可用/);
  });
});

describe('命令构造（纯函数——各家官方非交互语义）', () => {
  it('install：winget -e 精确+协议自动接受+禁交互；scoop 直装；choco -y --no-progress', () => {
    expect(buildInstallArgs('winget', 'Git.Git')).toEqual(['install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']);
    expect(buildInstallArgs('scoop', 'git')).toEqual(['install', 'git']);
    expect(buildInstallArgs('choco', 'git')).toEqual(['install', 'git', '-y', '--no-progress']);
  });
  it('search：winget 带协议接受；choco 纯输出', () => {
    expect(buildSearchArgs('winget', 'ripgrep')).toEqual(['search', 'ripgrep', '--accept-source-agreements']);
    expect(buildSearchArgs('choco', 'ripgrep')).toEqual(['search', 'ripgrep', '--limit-output', '--exact', 'false']);
  });
});

describe('searchPackages / installPackage（runner 注入）', () => {
  it('search：命中管理器并透传结果', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: SysRunner = async (bin, args) => {
      calls.push({ bin, args });
      return bin === 'winget' ? { code: 0, stdout: 'Git.Git 搜索结果', stderr: '' } : { code: -1, stdout: '', stderr: '' };
    };
    const r = await searchPackages('git', { runner });
    expect(r.ok).toBe(true);
    expect(r.manager).toBe('winget');
    expect(r.output).toContain('Git.Git');
    expect(calls.some(c => c.bin === 'winget' && c.args[0] === 'search')).toBe(true);
  });
  it('install：失败诚实回退出码与 stderr 尾部', async () => {
    const runner: SysRunner = async bin => (bin === 'winget'
      ? { code: 0, stdout: '', stderr: '' }
      : { code: -1, stdout: '', stderr: '' }) as { code: number; stdout: string; stderr: string };
    const runnerFail: SysRunner = async bin => (bin === 'winget'
      ? { code: -1, stdout: '', stderr: 'x' }
      : { code: -1, stdout: '', stderr: '' });
    // 探测失败场景：winget --version 失败 → choco 探测也失败 → throw
    await expect(installPackage('X', { runner: runnerFail })).rejects.toThrow(/未找到任何包管理器/);
    resetPkgManagerCacheForTests(); // 探测失败缓存 null——场景切换前清除
    // 真实安装失败路径：探测 ok 但 install 返回非零
    const runnerInst: SysRunner = async (bin, args) => {
      if (args[0] === '--version') return bin === 'winget' ? { code: 0, stdout: 'v1', stderr: '' } : { code: -1, stdout: '', stderr: '' };
      return { code: 0x80070002, stdout: '', stderr: '未找到包 X' };
    };
    const r = await installPackage('Nope.X', { runner: runnerInst });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('安装失败');
  });
});
