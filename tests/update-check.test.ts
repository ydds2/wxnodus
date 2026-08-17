// tests/update-check.test.ts — /update 更新检查：渠道探测/指引/报告（分发闭环 S0）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstallChannel, findRepoRoot, channelGuidance, buildUpdateReport, probeGit } from '../src/commands/updateCheck.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });

describe('detectInstallChannel 渠道探测（纯函数）', () => {
  it('npm 全局安装路径 → npm-global', () => {
    expect(detectInstallChannel('C:/Users/u/AppData/Roaming/npm/node_modules/wxnodus/dist/cli/index.js')).toBe('npm-global');
    expect(detectInstallChannel('/usr/lib/node_modules/wxnodus/dist/cli/index.js')).toBe('npm-global');
  });

  it('仓库内 dist/src 路径 → git（npm link 目标即仓库，同一渠道）', () => {
    expect(detectInstallChannel('C:/dev/wxnodus/dist/cli/index.js')).toBe('git');
    expect(detectInstallChannel('C:/dev/wxnodus/src/cli/index.ts')).toBe('git');
  });
});

describe('findRepoRoot 仓库根定位（纯函数）', () => {
  it('沿路径上探命中 name=wxnodus 的 package.json', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-root-'));
    dirs.push(d);
    mkdirSync(join(d, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'wxnodus', version: '3.1.0' }));
    const root = findRepoRoot(join(d, 'dist', 'cli', 'index.js'));
    expect(root).toBe(d);
  });

  it('无 wxnodus package.json → null', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-noroot-'));
    dirs.push(d);
    expect(findRepoRoot(join(d, 'x', 'y.js'))).toBeNull();
  });
});

describe('channelGuidance 渠道指引（纯函数）', () => {
  it('git 无 remote → 如实说明不可拉取', () => {
    const g = channelGuidance('git', { isRepo: true, remote: null, clean: true, head: 'abc123', date: '2026-08-18' });
    expect(g).toContain('未配置 git remote');
    expect(g).toContain('abc123');
  });

  it('git 脏树 → 拒绝指引自动更新', () => {
    const g = channelGuidance('git', { isRepo: true, remote: 'https://x', clean: false, head: 'abc', date: '' });
    expect(g).toContain('未提交改动');
  });

  it('git 可更新 → 给出 pull+build 命令', () => {
    const g = channelGuidance('git', { isRepo: true, remote: 'https://x', clean: true, head: 'abc', date: '' });
    expect(g).toBe('git pull && npm install && npm run build（远程 https://x）');
  });

  it('npm-global / winget / scoop / unknown 各有确切命令', () => {
    expect(channelGuidance('npm-global', null)).toContain('npm install -g');
    expect(channelGuidance('winget', null)).toContain('winget upgrade');
    expect(channelGuidance('scoop', null)).toContain('scoop update wxnodus');
    expect(channelGuidance('unknown', null)).toContain('无法确定安装渠道');
  });
});

describe('buildUpdateReport 报告汇总（真实 probeGit 降级路径）', () => {
  it('非 git 目录运行 → isRepo=false + 诚实指引 + 不可自动更新', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-nogit-'));
    dirs.push(d);
    mkdirSync(join(d, 'dist', 'cli'), { recursive: true });
    const r = buildUpdateReport({ modulePath: join(d, 'dist', 'cli', 'index.js'), cwd: d });
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.channel).toBe('git');
    expect(r.git?.isRepo).toBe(false);
    expect(r.guidance).toContain('不在 git 工作树内');
    expect(r.canAutoUpdate).toBe(false);
  });

  it('probeGit 非仓库目录 → isRepo=false 不抛错', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-probe-'));
    dirs.push(d);
    expect(probeGit(d).isRepo).toBe(false);
  });
});
