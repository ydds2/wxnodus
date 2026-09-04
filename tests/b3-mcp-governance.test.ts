// tests/b3-mcp-governance.test.ts — B3（2026-09-04）：/mcp 进程治理表面契约
//   list：在线状态/内存列（组合根真实连接 + 进程枚举真实工作集）；未信任项目条目诚实标注；
//   idle：settings.mcpIdleTeardown 写穿透（组合根 15s 清扫消费同一 settings——热切换零重启）；
//   status：未连接条目真实 initialize 探活（SDK 链路 mock——真机探活由实机证据覆盖）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, type Db } from '../src/store/db.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';

const { procs } = vi.hoisted(() => ({
  procs: [{ pid: 4242, ppid: 1, name: 'node.exe', cmdline: 'npx -y mcp-git', workingSetBytes: 45 * 1024 * 1024 }],
}));
vi.mock('../src/kernel/processScan.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/kernel/processScan.js')>();
  return { ...mod, listProcesses: vi.fn(async () => procs) };
});
vi.mock('../src/infrastructure/mcp/mcpClientHost.js', () => ({
  connectMcp: vi.fn(async (config: any) => {
    if (String(config?.command ?? '').includes('broken')) throw new Error('spawn ENOENT broken');
    return { era: '2025-06-18', negotiatedVersion: '2025-06-18', dispose: vi.fn(async () => {}) };
  }),
}));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function setup() {
  const d = mkdtempSync(join(tmpdir(), 'wx-b3-')); dirs.push(d);
  const db = openDB(d);
  const bus = createCommandBus();
  const evBus = createEventBus(d);
  const mem = createMemory(db);
  const settings: Record<string, any> = {};
  const setKeyCalls: Array<[string, string, any]> = [];
  const config = {
    get: (p: string) => (p === 'settings' ? settings : {}),
    getKey: (p: string, k: string) => (p === 'settings' ? settings[k] : undefined),
    setKey: (p: string, k: string, v: any) => { setKeyCalls.push([p, k, v]); settings[k] = v; },
  };
  const liveClient = (name: string, tools = ['status', 'log']) => ({
    server: { name, command: 'npx', args: ['-y', `mcp-${name}`], toolDanger: {} },
    tools: tools.map(t => ({ server: name, name: t })),
    connected: true,
    process: { pid: 4242 },
    callTool: async () => 'x',
    close: async () => {},
  });
  const ctx = {
    dataDir: d, cwd: d, db, mem, bus: evBus, config,
    getMcpClients: () => [] as any[],
    getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {}, getThemeName: () => 'wxnodus',
    requestExit: () => {}, clearHistory: () => {}, setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
  } as any;
  registerExtHandlers(bus, ctx);
  return { d, db, bus, settings, setKeyCalls, ctx, liveClient };
}

describe('/mcp list（在线状态 + 内存列）', () => {
  it('在线连接：pid/内存/工具数真实展示；未连接条目诚实标注', async () => {
    const { d, db, bus, ctx, liveClient } = setup();
    writeFileSync(join(d, 'mcp.json'), JSON.stringify([
      { name: 'git', command: 'npx', args: ['-y', 'mcp-git'] },
      { name: 'ghost', command: 'no-such-cmd' },
    ]));
    ctx.getMcpClients = () => [liveClient('git')];
    const r = await bus.execute('/mcp list');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('git');
    expect(r.output).toContain('在线');
    expect(r.output).toContain('pid 4242');
    expect(r.output).toContain('45.0MB');
    expect(r.output).toContain('2 工具');
    expect(r.output).toContain('未连接（/mcp status ghost 探活真因）');
    expect(r.output).toContain('闲置下线：关闭');
    db.close();
  });

  it('项目级未信任条目 → 未信任标注（不误报未连接）', async () => {
    const { d, db, bus, ctx } = setup();
    mkdirSync(join(d, 'proj'), { recursive: true });
    writeFileSync(join(d, 'proj', '.mcp.json'), JSON.stringify({ mcpServers: { secret: { command: 'node', args: ['x.js'] } } }));
    ctx.cwd = join(d, 'proj');
    const r = await bus.execute('/mcp list');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('secret');
    expect(r.output).toContain('未信任（/mcp trust secret');
    db.close();
  });
});

describe('/mcp idle（闲置下线开关）', () => {
  it('on 120 写穿透 settings.mcpIdleTeardown；非法秒数拒绝；off 关闭；裸命令展示状态', async () => {
    const { bus, setKeyCalls, settings } = setup();
    const on = await bus.execute('/mcp idle on 120');
    expect(on.ok).toBe(true);
    expect(on.output).toContain('闲置下线已开启');
    expect(setKeyCalls).toContainEqual(['settings', 'mcpIdleTeardown', { enabled: true, idleSeconds: 120 }]);

    const bad = await bus.execute('/mcp idle on 5');
    expect(bad.output).toContain('30–3600');

    const state = await bus.execute('/mcp idle');
    expect(state.output).toContain('开启');
    expect(state.output).toContain('120s');

    const off = await bus.execute('/mcp idle off');
    expect(off.output).toContain('已关闭');
    expect(settings.mcpIdleTeardown).toEqual({ enabled: false });
  });
});

describe('/mcp status（未连接条目真实探活）', () => {
  it('探活成功在线 / 失败报真因——绝不把未连通标在线', async () => {
    const { d, db, bus } = setup();
    writeFileSync(join(d, 'mcp.json'), JSON.stringify([
      { name: 'ok', command: 'npx', args: ['-y', 'mcp-ok'] },
      { name: 'broken', command: 'broken', args: [] },
    ]));
    const r = await bus.execute('/mcp status');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('✓ [Node] ok');
    expect(r.output).toContain('era 2025-06-18');
    expect(r.output).toContain('✗ [Custom] broken');
    expect(r.output).toContain('spawn ENOENT');
    expect(r.output).toContain('在线 1/2');
    db.close();
  });
});
