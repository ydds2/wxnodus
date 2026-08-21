// tests/kernel-selfUpdate.test.ts — V4 P5-1：自升级引擎
// 契约：①绝不自动安装（引擎只有显式 apply）②失败保持旧版可运行（备份+自动恢复）
// ③sha256 不匹配绝不安装 ④跳过状态持久化 ⑤feed 双形态解析+语义化版本比较
// ⑥气隙 --file 同链路（CLI 层读取本地 zip 字节后走同一 applyUpdate）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  isNewerVersion, fetchLatestRelease, loadUpdateState, markVersionSkipped,
  applyUpdate, rollbackUpdate,
} from '../src/kernel/selfUpdate.js';

const work = () => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', 'wx-upd-'));
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const mockFetch = (body: unknown, status = 200): typeof fetch & { calls: string[] } => {
  const fn = (async (url: any) => {
    (fn as any).calls.push(String(url));
    if (status >= 400) return { ok: false, status, json: async () => ({}) } as any;
    return { ok: true, status, json: async () => body } as any;
  }) as any;
  fn.calls = [];
  return fn;
};

describe('isNewerVersion 语义化比较', () => {
  it('主三段数值比较 + 预发布低于正式版', () => {
    expect(isNewerVersion('4.0.1', '4.0.0')).toBe(true);
    expect(isNewerVersion('4.1.0', '4.0.99')).toBe(true);
    expect(isNewerVersion('5.0.0', '4.99.99')).toBe(true);
    expect(isNewerVersion('4.0.0', '4.0.0')).toBe(false);
    expect(isNewerVersion('3.9.9', '4.0.0')).toBe(false);
    expect(isNewerVersion('v4.0.1', '4.0.0')).toBe(true); // v 前缀容忍
    expect(isNewerVersion('4.0.0-rc.2', '4.0.0-rc.1')).toBe(true); // 预发布字典序
    expect(isNewerVersion('4.0.0', '4.0.0-rc.1')).toBe(true); // 正式 > 预发布
    expect(isNewerVersion('4.0.0-rc.1', '4.0.0')).toBe(false);
    expect(isNewerVersion('garbage', '4.0.0')).toBe(false); // 非法输入不误报
  });
});

describe('fetchLatestRelease feed 双形态', () => {
  it('自有 JSON 契约：{version,url,sha256}', async () => {
    const f = mockFetch({ version: '4.0.1', url: 'https://rel.example/wxnodus-4.0.1.zip', sha256: 'a'.repeat(64) });
    const r = await fetchLatestRelease('https://rel.example/feed.json', '4.0.0', f);
    expect(r.updateAvailable).toBe(true);
    expect(r.latest).toBe('4.0.1');
    expect(r.downloadUrl).toBe('https://rel.example/wxnodus-4.0.1.zip');
    expect(r.sha256).toBe('a'.repeat(64));
  });
  it('GitHub Release API 形态：tag_name + zip asset', async () => {
    const f = mockFetch({ tag_name: 'v4.1.0', assets: [{ browser_download_url: 'https://gh.example/wxnodus-4.1.0.zip' }, { browser_download_url: 'https://gh.example/notes.txt' }] });
    const r = await fetchLatestRelease('https://api.github.com/repos/x/y/releases/latest', '4.0.0', f);
    expect(r.updateAvailable).toBe(true);
    expect(r.latest).toBe('4.1.0');
    expect(r.downloadUrl).toBe('https://gh.example/wxnodus-4.1.0.zip');
  });
  it('未配置 feed 诚实降级；网络/HTTP 失败不误报可用', async () => {
    const none = await fetchLatestRelease(null, '4.0.0');
    expect(none.updateAvailable).toBe(false);
    expect(none.notes).toContain('未配置');
    const httpFail = await fetchLatestRelease('https://x.example/feed', '4.0.0', mockFetch({}, 500));
    expect(httpFail.updateAvailable).toBe(false);
    expect(httpFail.notes).toContain('500');
    const netFail = await fetchLatestRelease('https://x.example/feed', '4.0.0', (async () => { throw new Error('timeout'); }) as any);
    expect(netFail.updateAvailable).toBe(false);
    expect(netFail.notes).toContain('不可达');
  });
});

describe('跳过状态（用户裁决）', () => {
  it('--skip 版本持久化且幂等', () => {
    const d = work(); dirs.push(d);
    markVersionSkipped(d, '4.0.1');
    markVersionSkipped(d, '4.0.1'); // 重复跳过不重复记录
    const st = loadUpdateState(d);
    expect(st.skipped).toEqual(['4.0.1']);
  });
});

describe('applyUpdate 安装链', () => {
  const mkDeps = (installedVersion: string | null, installerOk = true) => ({
    extractCalls: [] as string[],
    installCalls: [] as Array<[string, string]>,
    extract: async (_buf: Buffer, dest: string) => { mkdirSync(dest, { recursive: true }); },
    runInstaller: async (zipDir: string, target: string) => {
      const deps = mkDeps as any;
      deps.calls.push([zipDir, target]);
      return installerOk ? { ok: true, output: 'INSTALLED' } : { ok: false, output: 'INSTALLER_FAILED' };
    },
    verifyInstalled: async () => installedVersion,
  });
  // 简单闭包记录（上面 mkDeps.calls 借宿主对象传递）
  const depsRec = { calls: [] as Array<[string, string]> };

  it('sha256 不匹配 → 绝不安装（步骤 0 拒绝）', async () => {
    const d = work(); dirs.push(d);
    const target = join(d, 'app');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'cli.txt'), 'old');
    const r = await applyUpdate({
      zipBuffer: Buffer.from('evil'),
      expectedSha256: 'f'.repeat(64),
      targetDir: target,
      extract: async () => { throw new Error('不应到达'); },
      runInstaller: async () => { throw new Error('不应到达'); },
      verifyInstalled: async () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('sha256');
    expect(readFileSync(join(target, 'cli.txt'), 'utf8')).toBe('old'); // 原样未动
  });

  it('成功链：备份 → 安装 → 验证；.prev 保留（rollback 出口）', async () => {
    const d = work(); dirs.push(d);
    const target = join(d, 'app');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'marker.txt'), 'v1');
    const buf = Buffer.from('new-package');
    const r = await applyUpdate({
      zipBuffer: buf,
      expectedSha256: createHash('sha256').update(buf).digest('hex'),
      targetDir: target,
      extract: async (_b, dest) => { mkdirSync(dest, { recursive: true }); },
      runInstaller: async (zipDir, t) => { depsRec.calls.push([zipDir, t]); return { ok: true, output: 'INSTALLED' }; },
      verifyInstalled: async () => '4.0.1',
    });
    expect(r.ok).toBe(true);
    expect(r.steps.join('\n')).toContain('sha256 校验通过');
    expect(r.steps.join('\n')).toContain('已备份当前版本');
    expect(existsSync(`${target}.prev`)).toBe(true); // N-1 备份保留
    expect(existsSync(join(`${target}.prev`, 'marker.txt'))).toBe(true);
    expect(depsRec.calls.length).toBe(1);
  });

  it('装后验证失败 → 自动恢复备份（失败保持旧版可运行——验收红线）', async () => {
    const d = work(); dirs.push(d);
    const target = join(d, 'app');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'app.txt'), 'OLD-RUNNING');
    const r = await applyUpdate({
      zipBuffer: Buffer.from('broken'),
      targetDir: target,
      extract: async () => {},
      runInstaller: async () => ({ ok: true, output: 'ok' }),
      verifyInstalled: async () => null, // 装后验证失败
    });
    expect(r.ok).toBe(false);
    expect(r.steps.join('\n')).toContain('已自动恢复备份');
    expect(readFileSync(join(target, 'app.txt'), 'utf8')).toBe('OLD-RUNNING'); // 旧版可运行
    expect(existsSync(`${target}.prev`)).toBe(false); // 恢复耗尽备份
  });

  it('安装器失败 → 同样自动恢复', async () => {
    const d = work(); dirs.push(d);
    const target = join(d, 'app');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'app.txt'), 'OLD');
    const r = await applyUpdate({
      zipBuffer: Buffer.from('x'),
      targetDir: target,
      extract: async () => {},
      runInstaller: async () => ({ ok: false, output: 'POWERSHELL_BLOWN' }),
      verifyInstalled: async () => '9.9.9',
    });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(target, 'app.txt'), 'utf8')).toBe('OLD');
  });
});

describe('rollbackUpdate 回退', () => {
  it('有 .prev → 互换（可再次 rollback 往返）', async () => {
    const d = work(); dirs.push(d);
    const target = join(d, 'app');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'v.txt'), 'new');
    mkdirSync(`${target}.prev`, { recursive: true });
    writeFileSync(join(`${target}.prev`, 'v.txt'), 'old');
    const r = await rollbackUpdate(target);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(target, 'v.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(`${target}.prev`, 'v.txt'), 'utf8')).toBe('new');
  });
  it('无备份 → 诚实拒绝', async () => {
    const d = work(); dirs.push(d);
    const r = await rollbackUpdate(join(d, 'nothing'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无可回退备份');
  });
});

// ── CLI 进程级（exit code + 状态落盘） ──
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const CLI = resolve(__dirname, '../dist/cli/index.js');
const hasDist = existsSync(CLI);
const describeWithDist = hasDist ? describe : describe.skip;

describeWithDist('wxnodus update 子命令（进程级）', () => {
  const runCli = (args: string[]) => new Promise<{ code: number | null; stdout: string; dataDir: string }>((res, rej) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wxn-upd-'));
    dirs.push(dataDir);
    const child = spawn(process.execPath, [CLI, '--data-dir', dataDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout!.on('data', (c: Buffer) => { out += String(c); });
    child.on('error', rej);
    child.on('close', code => res({ code, stdout: out, dataDir }));
  });

  it('默认（--check 语义）：诚实报告当前版本/未配置 feed，exit 0', async () => {
    const r = await runCli(['update']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('当前版本');
    expect(r.stdout).toContain('未配置');
    expect(r.stdout).toContain('已是最新');
  }, 60_000);

  it('--skip <ver>：状态落盘 + 后续报告标注已跳过', async () => {
    const r = await runCli(['update', '--skip', '9.9.9']);
    expect(r.code).toBe(0);
    expect(existsSync(join(r.dataDir, 'update-state.json'))).toBe(true);
    expect(loadUpdateState(r.dataDir).skipped).toContain('9.9.9');
  }, 60_000);

  it('--file 在非 zip 安装目录（git/npm 渠道）：诚实拒绝 exit 1', async () => {
    const zipPath = join(tmpdir(), `fake-${Date.now()}.zip`);
    writeFileSync(zipPath, 'not-a-real-zip');
    const r = await runCli(['update', '--file', zipPath]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('zip 渠道');
    rmSync(zipPath, { force: true });
  }, 60_000);
});
