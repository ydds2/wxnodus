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
  parseHeartbeatLine, parseHeartbeatLog, readHeartbeatLogs, analyzeHeartbeatGaps,
  type DoctorReport,
} from '../src/kernel/doctor.js';

const work = () => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', 'wx-doc-'));
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const mkDb = (d: string): Db => openDB(d);
// B1：单元级注入空进程表——测试隔离真实 PowerShell 枚举（真机采集由 CLI 进程级用例覆盖）
const noProcs = async () => [] as Array<{ pid: number; ppid: number; name: string; cmdline: string }>;
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

  // B1（2026-09-04）：心跳行解析 + 断档判定纯函数
  it('parseHeartbeatLine：新格式带 pid 解析；旧格式无 pid 诚实跳过', () => {
    expect(parseHeartbeatLine('2026-09-04T08:00:00.000Z alive pid=1234')).toEqual({ pid: 1234, at: Date.parse('2026-09-04T08:00:00.000Z') });
    expect(parseHeartbeatLine('2026-09-04T08:00:00Z alive pid=5678')).toEqual({ pid: 5678, at: Date.parse('2026-09-04T08:00:00Z') });
    expect(parseHeartbeatLine('2026-09-04T08:00:00.000Z alive')).toBeNull(); // 旧格式无法关联进程
    expect(parseHeartbeatLine('garbage line')).toBeNull();
  });

  it('parseHeartbeatLog：多会话交错日志按 pid 保留最新一拍', () => {
    const log = parseHeartbeatLog([
      '2026-09-04T08:00:00Z alive pid=1',
      '2026-09-04T08:00:02Z alive pid=2',
      '2026-09-04T08:00:04Z alive pid=1',
      'junk',
    ].join('\n'), 'heartbeat-2026-09-04.log');
    expect(log.file).toBe('heartbeat-2026-09-04.log');
    expect(log.lastByPid.get(1)).toBe(Date.parse('2026-09-04T08:00:04Z'));
    expect(log.lastByPid.get(2)).toBe(Date.parse('2026-09-04T08:00:02Z'));
  });

  it('analyzeHeartbeatGaps：存活且断档→frozen；已死/新鲜/自身→不入围', () => {
    const t0 = Date.parse('2026-09-04T08:00:00Z');
    const logs = [parseHeartbeatLog(`2026-09-04T07:58:00Z alive pid=101\n2026-09-04T07:59:50Z alive pid=102`, 'hb.log')];
    const procs = [
      { pid: 101, ppid: 0, name: 'node.exe', cmdline: 'wxnodus' }, // 存活但断档 120s
      { pid: 102, ppid: 0, name: 'node.exe', cmdline: 'x' },       // 存活且新鲜（10s）
      { pid: 103, ppid: 0, name: 'node.exe', cmdline: 'x' },       // 日志断档但进程已死
    ];
    const r = analyzeHeartbeatGaps(logs, procs, t0, 15_000, 999);
    expect(r.frozen.map(f => f.pid)).toEqual([101]);
    expect(r.frozen[0]!.gapMs).toBe(120_000);
    expect(r.checked).toBe(2);
    // 自身 pid 的陈旧心跳不入围（doctor 进程自身不算卡死）
    const self = analyzeHeartbeatGaps([parseHeartbeatLog('2026-09-04T07:50:00Z alive pid=999', 'hb.log')], [{ pid: 999, ppid: 0, name: 'node.exe', cmdline: 'x' }], t0, 15_000, 999);
    expect(self.frozen).toEqual([]);
  });

  it('readHeartbeatLogs：目录缺失→空表；坏行诚实跳过', () => {
    const d = work(); dirs.push(d);
    expect(readHeartbeatLogs(join(d, 'logs'))).toEqual([]);
    mkdirSync(join(d, 'logs'), { recursive: true });
    writeFileSync(join(d, 'logs', 'heartbeat-2026-09-04.log'), 'not a heartbeat\n2026-09-04T08:00:00Z alive pid=42\n');
    writeFileSync(join(d, 'logs', 'error-2026-09-04.log'), 'x');
    const logs = readHeartbeatLogs(join(d, 'logs'));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.lastByPid.get(42)).toBe(Date.parse('2026-09-04T08:00:00Z'));
  });
});

describe('B1 引擎：孤儿进程/心跳断档体检项', () => {
  it('注入疑似孤儿 → warn + pid 列表；心跳断档存活进程 → warn', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const t0 = Date.now();
    const stale = new Date(t0 - 60_000).toISOString();
    const procs = [
      { pid: 4242, ppid: 1, name: 'node.exe', cmdline: 'node tmp-n2-probe-x' },
      { pid: 3131, ppid: 1, name: 'node.exe', cmdline: 'wxnodus' },
    ];
    const r = await runDoctor({
      dataDir: d, db, settings: {}, cwd: d, network: false,
      processScan: async () => procs,
      heartbeatLogs: [parseHeartbeatLog(`${stale} alive pid=3131`, 'heartbeat-2026-09-04.log')],
    });
    expect(statusOf(r, '孤儿进程')).toBe('warn');
    expect(detailOf(r, '孤儿进程')).toContain('4242');
    expect(detailOf(r, '孤儿进程')).toContain('3131');
    expect(statusOf(r, '心跳探针')).toBe('warn');
    expect(detailOf(r, '心跳探针')).toContain('3131');
    db.close();
  });

  it('进程枚举失败 → 两项诚实 info（绝不伪造空表）', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const r = await runDoctor({
      dataDir: d, db, settings: {}, cwd: d, network: false,
      processScan: async () => { throw new Error('powershell 不可用'); },
      heartbeatLogs: [parseHeartbeatLog('2026-09-04T08:00:00Z alive pid=1', 'hb.log')],
    });
    expect(statusOf(r, '孤儿进程')).toBe('info');
    expect(detailOf(r, '孤儿进程')).toContain('无法探测');
    expect(statusOf(r, '心跳探针')).toBe('info');
    expect(detailOf(r, '心跳探针')).toContain('跳过');
    db.close();
  });

  it('有日志且进程枚举可用但全新鲜 → 心跳 ok', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const fresh = new Date(Date.now() - 2000).toISOString();
    const r = await runDoctor({
      dataDir: d, db, settings: {}, cwd: d, network: false,
      processScan: async () => [{ pid: 1, ppid: 1, name: 'node.exe', cmdline: '' }],
      heartbeatLogs: [parseHeartbeatLog(`${fresh} alive pid=1`, 'hb.log')],
    });
    expect(statusOf(r, '心跳探针')).toBe('ok');
    expect(detailOf(r, '心跳探针')).toContain('心跳正常');
    db.close();
  });
});

describe('runDoctor 引擎（local：network=false）', () => {
  it('全新环境：无 fail、exitCode 0、网络项诚实跳过', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false, processScan: noProcs });
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
    // B1：孤儿进程/心跳探针两项在场（空注入 → ok/info，不污染 exit code）
    expect(statusOf(r, '孤儿进程')).toBe('ok');
    expect(statusOf(r, '心跳探针')).toBe('info');
    db.close();
  });

  it('审计链篡改：hash 损坏 → fail + exitCode 1', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    appendAudit(db, 'tool.executed', { tool: 'bash' });
    appendAudit(db, 'tool.executed', { tool: 'fs_edit' });
    db.prepare(`UPDATE audit SET hash='broken' WHERE id=1`).run();
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false, processScan: noProcs });
    expect(statusOf(r, '审计链')).toBe('fail');
    expect(detailOf(r, '审计链')).toContain('id=1');
    expect(r.exitCode).toBe(1);
    db.close();
  });

  it('磁盘余量：真实 statfs 探测并按阈值分级（临时卷正常环境 ≥1GB）', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false, processScan: noProcs });
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
      processScan: noProcs,
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
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, fetchImpl: f, processScan: noProcs });
    expect(statusOf(r, '端点连通')).toBe('ok');
    expect(detailOf(r, '端点连通')).toContain('HTTP 401');
    db.close();
  });

  it('端点不可达 + 已配密钥（env 注入）→ fail；未配密钥 → warn（离线不误报故障）', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    const f = mockFetch(); // 全超时
    const withKey = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, fetchImpl: f, env: { WXNODUS_API_KEY: 'sk-test' } as any, processScan: noProcs });
    expect(statusOf(withKey, '端点连通')).toBe('fail');
    expect(withKey.exitCode).toBe(1);
    const noKey = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, fetchImpl: f, processScan: noProcs });
    expect(statusOf(noKey, '端点连通')).toBe('warn');
    db.close();
  });

  it('更新通道不可达 → warn（气隙部署合法，绝不 fail）', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    // zip 渠道夹具（确定性渠道：install-meta.json + https 更新源——不受测试环境 git/npm 渠道影响）
    writeFileSync(join(d, 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '9.9.9', source: 'https://update.example/wxnodus.zip' }));
    const f = mockFetch(); // 全超时
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, modulePath: join(d, 'fake.js'), fetchImpl: f, processScan: noProcs });
    expect(statusOf(r, '更新通道')).toBe('warn');
    expect(detailOf(r, '更新通道')).toContain('离线部署属正常');
    db.close();
  });

  it('更新通道可达 → ok 且带渠道与当前版本', async () => {
    const d = work(); dirs.push(d);
    const db = mkDb(d);
    writeFileSync(join(d, 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '9.9.9', source: 'https://update.example/wxnodus.zip' }));
    const f = mockFetch({ 'update.example': { status: 200 }, 'api': { status: 404 } });
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, modulePath: join(d, 'fake.js'), fetchImpl: f, processScan: noProcs });
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
    const r = await runDoctor({ dataDir: d, db, settings: {}, cwd: d, network: false, processScan: noProcs });
    const text = renderDoctorText(r);
    expect(text).toContain('✓ 数据库完整性');
    expect(text).toContain('· 模型密钥');
    expect(text).toMatch(/汇总：\d+ 正常 · \d+ 提示 · \d+ 故障 · \d+ 信息 —— exit 0/);
    db.close();
  });
});

// ── CLI 进程级（exit code 可判——P4-3 验收核心） ─────────────────────
const CLI = resolve(__dirname, '../dist/cli/index.js');
// Q3（2026-09-04）：dist 门统一 support/distGate——缺 dist 显式红而非静默 skip（六天红同族治理）
import { describeWithDist } from './support/distGate.js';

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
    // B1：卡死自愈体检项在真实进程级输出中在场
    expect(r.stdout).toContain('孤儿进程');
    expect(r.stdout).toContain('心跳探针');
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
