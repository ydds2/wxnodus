// tests/update-check.test.ts — /update 更新检查：渠道探测/指引/报告（分发闭环 S0）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstallChannel, findRepoRoot, channelGuidance, buildUpdateReport, probeGit, findInstallMeta, probeRemoteVersion } from '../src/commands/updateCheck.js';

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

describe('zip 渠道（install-meta）', () => {
  it('findInstallMeta 上探命中 / 缺失 null / JSON 损坏 null / BOM 容忍', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-meta-'));
    dirs.push(d);
    mkdirSync(join(d, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(d, 'a', 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '3.1.0', source: 'https://x.example/wxnodus-3.1.0.zip' }), 'utf8');
    const meta = findInstallMeta(join(d, 'a', 'b', 'c', 'x.js'));
    expect(meta).toMatchObject({ app: 'wxnodus', version: '3.1.0' });
    expect(findInstallMeta(join(d, 'other', 'x.js'))).toBeNull();
    writeFileSync(join(d, 'a', 'install-meta.json'), '{broken', 'utf8');
    expect(findInstallMeta(join(d, 'a', 'b', 'c', 'x.js'))).toBeNull();
    writeFileSync(join(d, 'a', 'install-meta.json'), '\uFEFF' + JSON.stringify({ app: 'wxnodus', version: '3.1.0' }), 'utf8');
    expect(findInstallMeta(join(d, 'a', 'b', 'c', 'x.js'))).toMatchObject({ version: '3.1.0' });
  });

  it('detectInstallChannel 识别 zip 优先于 git', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-zipch-'));
    dirs.push(d);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '3.1.0' }), 'utf8');
    expect(detectInstallChannel(join(d, 'dist', 'cli', 'index.js'))).toBe('zip');
  });

  it('probeRemoteVersion：HEAD 提取版本；非 https 拒绝；失败诚实', async () => {
    const okFetch = (async () => new Response('', { status: 200, headers: { 'content-disposition': 'attachment; filename="wxnodus-3.2.0.zip"' } })) as unknown as typeof fetch;
    const r1 = await probeRemoteVersion('https://x.example/wxnodus-3.2.0.zip', okFetch);
    expect(r1.ok).toBe(true);
    expect(r1.version).toBe('3.2.0');
    const r2 = await probeRemoteVersion('http://x.example/a.zip', okFetch);
    expect(r2.ok).toBe(false);
    const badFetch = (async () => { throw new Error('net down'); }) as unknown as typeof fetch;
    const r3 = await probeRemoteVersion('https://x.example/a.zip', badFetch);
    expect(r3.ok).toBe(false);
    expect(r3.message.length).toBeGreaterThan(0);
  });

  it('channelGuidance zip 分支 + buildUpdateReport 透出 installMeta', () => {
    const g = channelGuidance('zip', null);
    expect(g).toContain('install.ps1');
    const d = mkdtempSync(join(tmpdir(), 'wx-rep-'));
    dirs.push(d);
    writeFileSync(join(d, 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '3.1.0', source: 'https://x.example/wxnodus-3.1.0.zip' }), 'utf8');
    const report = buildUpdateReport({ modulePath: join(d, 'dist', 'cli', 'index.js'), cwd: d });
    expect(report.channel).toBe('zip');
    expect(report.installMeta?.version).toBe('3.1.0');
  });
});
