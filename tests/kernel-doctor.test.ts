// tests/kernel-doctor.test.ts — V4 P4-3：doctor 全链路自诊断引擎
// 契约：结构化四态（ok/warn/fail/info）+ exit code 可判（0/1）+ 网络项可跳过 +
// 「未配置=初始状态不污染 exit code」+ 审计链篡改检出 + CLI 子命令进程级 exit code。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openDB, appendAudit, type Db } from '../src/store/db.js';
import {
  runDoctor, renderDoctorText, diskStatus, detectTerminalTier, describeProxy, updateChannelEndpoint,
  type DoctorReport,
} from '../src/kernel/doctor.js';

const work = () => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', 'wx-doc-'));
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const mkDb = (d: string): Db => openDB(d);
const find = (r: DoctorReport, item: string) => r.checks.find(c => c.item === item)!;
const statusOf = (r: DoctorReport, item: string) => find(r, item)?.status;
const detailOf = (r: DoctorReport, item: string) => find(r, item)?.detail ?? '';

// 网络 mock：默认全部失败（超时语义）；可按 URL 分支
const mockFetch = (branches: Record<string, { status: number } | Error> = {}): typeof fetch & { urls: string[] } => {
  const fn = (async (url: any) => {
    (fn as any).urls.push(String(url));
    for (const [k, v] of Object.entries(branches)) {
      if (String(url).includes(k)) {
        if (v instanceof Error) throw v;
        return { status: v.status, ok: v.status < 400, headers: new Map(), url: String(url) } as any;
      }
    }
    throw new Error('mock 超时');
  }) as any;
  fn.urls = [];
  return fn;
};

describe('纯函数', () => {
  it('diskStatus：<100MB fail / <1GB warn / 其余 ok', () => {
    expect(diskStatus(50 * 1024 * 1024)).toBe('fail');
    expect(diskStatus(500 * 1024 * 1024)).toBe('warn');
    expect(diskStatus(5 * 1024 ** 3)).toBe('ok');
  });
  it('detectTerminalTier：WT/ConEmu/TERM_PROGRAM/xterm/conhost 分支', () => {
    expect(detectTerminalTier({ WT_SESSION: '1' } as any, 'win32')).toContain('Windows Terminal');
    expect(detectTerminalTier({ ConEmuANSI: 'ON' } as any, 'win32')).toContain('ConEmu');
    expect(detectTerminalTier({ TERM_PROGRAM: 'vscode' } as any, 'win32')).toContain('vscode');
    expect(detectTerminalTier({ TERM: 'xterm-256color' } as any, 'linux')).toContain('modern');
    expect(detectTerminalTier({} as any, 'win32')).toContain('conhost');
    expect(detectTerminalTier({} as any, 'linux')).toContain('no-vt');
  });
  it('describeProxy：逐项列出/未配置直连', () => {
    expect(describeProxy({} as any)).toBe('未配置（直连）');
    expect(describeProxy({ HTTPS_PROXY: 'http://p:8080' } as any)).toContain('HTTPS=http://p:8080');
    expect(describeProxy({ HTTPS_PROXY: 'http://p:8080', NO_PROXY: 'localhost' } as any)).toContain('NO_PROXY=localhost');
  });
  it('updateChannelEndpoint：渠道→端点映射（ssh git/无源 zip 不可探测）', () => {
    expect(updateChannelEndpoint('npm-global', {})).toBe('https://registry.npmjs.org/-/ping');
    expect(updateChannelEndpoint('zip', { zipSource: 'https://x/y.zip' })).toBe('https://x/y.zip');
    expect(updateChannelEndpoint('zip', { zipSource: null })).toBeNull();
    expect(updateChannelEndpoint('git', { gitRemote: 'git@github.com:o/r.git' })).toBeNull();
    expect(updateChannelEndpoint('git', { gitRemote: 'https://github.com/o/r.git' })).toBe('https://github.com/o/r.git');
    expect(updateChannelEndpoint('winget', {})).toBe('https://api.github.com');
  });
});

describe('runDoctor 引擎（local：network=false）', () => {
  it('全新环境：无 fail、exitCode 0、网络项诚实跳过', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false });
    expect(r.counts.fail).toBe(0);
    expect(r.exitCode).toBe(0);
    expect(statusOf(r, '端点连通')).toBe('info');
    expect(detailOf(r, '端点连通')).toContain('local 模式');
    // 未配置 = 初始状态 info（不污染 exit code）
    expect(statusOf(r, '模型密钥')).toBe('info');
    expect(statusOf(r, '当前模型')).toBe('info');
    expect(statusOf(r, '接入档案')).toBe('info');
    // 本地核心项全 ok（fresh db 的 integrity/audit/记忆/FTS/原生依赖）
    expect(statusOf(r, '数据库完整性')).toBe('ok');
    expect(statusOf(r, '审计链')).toBe('ok');
    db.close();
  });

  it('审计链篡改：hash 损坏 → fail + exitCode 1', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    appendAudit(db, 'tool.executed', { tool: 'bash' });
    appendAudit(db, 'tool.executed', { tool: 'fs_edit' });
    db.prepare(`UPDATE audit SET hash='broken' WHERE id=1`).run();
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false });
    expect(statusOf(r, '审计链')).toBe('fail');
    expect(detailOf(r, '审计链')).toContain('id=1');
    expect(r.exitCode).toBe(1);
    db.close();
  });

  it('磁盘余量：真实 statfs 探测并按阈值分级（临时卷正常环境 ≥1GB）', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false });
    expect(['ok', 'warn', 'info']).toContain(statusOf(r, '磁盘余量'));
    expect(detailOf(r, '磁盘余量')).toMatch(/GB|MB 可用/);
    db.close();
  });

  it('终端档位/代理链路：env 注入透传', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const r = await runDoctor({
      dataDir: d, db, settings: {}, cwd: d, network: false,
      env: { WT_SESSION: 'abc', HTTPS_PROXY: 'http://proxy:7890' } as any,
    });
    expect(detailOf(r, '终端档位')).toContain('Windows Terminal');
    expect(detailOf(r, '代理链路')).toContain('http://proxy:7890');
    db.close();
  });
});

describe('runDoctor 引擎（网络项）', () => {
  it('端点可达（401 也是活着）：ok', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const f = mockFetch({ 'api': { status: 401 }, 'github': { status: 200 }, 'npmjs': { status: 200 } });
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, fetchImpl: f });
    expect(statusOf(r, '端点连通')).toBe('ok');
    expect(detailOf(r, '端点连通')).toContain('HTTP 401');
    db.close();
  });

  it('端点不可达 + 已配密钥（env 注入）→ fail；未配密钥 → warn（离线不误报故障）', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const f = mockFetch(); // 全超时
    const withKey = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, fetchImpl: f, env: { WXNODUS_API_KEY: 'sk-test' } as any });
    expect(statusOf(withKey, '端点连通')).toBe('fail');
    expect(withKey.exitCode).toBe(1);
    const noKey = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, fetchImpl: f });
    expect(statusOf(noKey, '端点连通')).toBe('warn');
    db.close();
  });

  it('更新通道不可达 → warn（气隙部署合法，绝不 fail）', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    // zip 渠道夹具（确定性渠道：install-meta.json + https 更新源——不受测试环境 git/npm 渠道影响）
    writeFileSync(join(d, 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '9.9.9', source: 'https://update.example/wxnodus.zip' }));
    const f = mockFetch(); // 全超时
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, modulePath: join(d, 'fake.js'), fetchImpl: f });
    expect(statusOf(r, '更新通道')).toBe('warn');
    expect(detailOf(r, '更新通道')).toContain('离线部署属正常');
    db.close();
  });

  it('更新通道可达 → ok 且带渠道与当前版本', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    writeFileSync(join(d, 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '9.9.9', source: 'https://update.example/wxnodus.zip' }));
    const f = mockFetch({ 'update.example': { status: 200 }, 'api': { status: 404 } });
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, modulePath: join(d, 'fake.js'), fetchImpl: f });
    expect(statusOf(r, '更新通道')).toBe('ok');
    expect(detailOf(r, '更新通道')).toMatch(/通道可达/);
    expect(detailOf(r, '更新通道')).toContain('离线 zip 安装'); // zip 夹具渠道生效（版本字段为包版本——既有语义）
    db.close();
  });
});

describe('renderDoctorText', () => {
  it('纯文本四态标记 + 汇总行 + exit 码', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false });
    const text = renderDoctorText(r);
    expect(text).toContain('✓ 数据库完整性');
    expect(text).toContain('· 模型密钥');
    expect(text).toMatch(/汇总：\d+ 正常 · \d+ 提示 · \d+ 故障 · \d+ 信息 —— exit 0/);
    db.close();
  });
});

// ── CLI 进程级（exit code 可判——P4-3 验收核心） ─────────────────────
const CLI = resolve(__dirname, '../dist/cli/index.js');
const hasDist = existsSync(CLI);
const describeWithDist = hasDist ? describe : describe.skip;

describeWithDist('wxnodus doctor 子命令（进程级）', () => {
  const runCli = (args: string[]) => new Promise<{ code: number | null; stdout: string }>((res, rej) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wxn-doc-'));
    dirs.push(dataDir);
    const child = spawn(process.execPath, [CLI, '--data-dir', dataDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += String(c); });
    child.on('error', rej);
    child.on('close', code => res({ code, stdout: out }));
  });

  it('doctor local：全新环境 exit 0 + 体检项齐全', async () => {
    const r = await runCli(['doctor', 'local']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('数据库完整性');
    expect(r.stdout).toContain('审计链');
    expect(r.stdout).toContain('端点连通');
    expect(r.stdout).toContain('exit 0');
  }, 60_000);

  it('doctor local --json：机读结构（ok/checks/exitCode）', async () => {
    const r = await runCli(['doctor', 'local', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; exitCode: number; checks: Array<{ item: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.checks.length).toBeGreaterThanOrEqual(14);
  }, 60_000);
});
