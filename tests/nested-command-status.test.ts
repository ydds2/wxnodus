// tests/nested-command-status.test.ts — 嵌套 Agent 命令六终态传播与 Arena 状态隔离
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandBus } from '../src/app/CommandBus.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createRunContext } from '../src/protocol/runs.js';
import { closeDB, openDB, type Db } from '../src/store/db.js';

const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) closeDB(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function harness(
  spawnSubagent: ReturnType<typeof vi.fn>,
  settings: Record<string, unknown> = {},
  delegateManager?: import('../src/application/autonomy/delegateManager.js').DelegateManager,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-nested-command-'));
  dirs.push(dataDir);
  const db = openDB(dataDir);
  dbs.push(db);
  const setModel = vi.fn();
  const setSessionId = vi.fn();
  const bus = createCommandBus();
  const ctx = {
    dataDir,
    cwd: dataDir,
    db,
    mem: createMemory(db),
    bus: createEventBus(dataDir),
    config: {
      get: (section: string) => section === 'settings' ? settings : {},
      getKey: () => undefined,
      setKey: () => undefined,
    },
    agent: {
      spawnSubagent,
      run: vi.fn(),
      abort: vi.fn(),
      setMode: vi.fn(),
      getMode: () => 'smart',
      setSessionId,
      getSessionId: () => 'main-session',
    },
    getModel: () => String(settings.model ?? ''),
    getMode: () => 'smart',
    setMode: vi.fn(),
    setTheme: vi.fn(),
    getThemeName: () => 'wxnodus',
    requestExit: vi.fn(),
    clearHistory: vi.fn(),
    setModel,
    openModelPicker: vi.fn(),
    openSessions: vi.fn(),
    setThinking: vi.fn(),
    delegateManager,
    liveDelegateHost: true,
  } as any;
  registerExtHandlers(bus, ctx);
  return { bus, db, setModel, setSessionId };
}

describe('嵌套 Agent 命令终态', () => {
  it('/swarm 部分成功映射 incomplete，并向每个子代理传播 signal', async () => {
    const spawn = vi.fn()
      .mockResolvedValueOnce({ ok: true, output: 'a', turns: 1 })
      .mockResolvedValueOnce({ ok: false, output: 'b', turns: 1, status: 'failed' });
    const { bus } = harness(spawn);
    const controller = new AbortController();

    const result = await bus.execute('/swarm 检查实现 2', { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.completionStatus).toBe('incomplete');
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const call of spawn.mock.calls) expect(call[3]).toEqual({ signal: controller.signal });
  });

  it('/duo 全部 blocked 映射 blocked', async () => {
    const spawn = vi.fn().mockResolvedValue({ ok: false, output: '不可用', turns: 0, status: 'blocked' });
    const { bus } = harness(spawn);

    const result = await bus.execute('/duo 比较方案');

    expect(result.ok).toBe(false);
    expect(result.completionStatus).toBe('blocked');
  });

  it('/btw 和 /review 保留 cancelled/failed 终态', async () => {
    const spawn = vi.fn()
      .mockResolvedValueOnce({ ok: false, output: '已取消', turns: 1, interrupted: true })
      .mockResolvedValueOnce({ ok: false, output: '审查失败', turns: 1, status: 'failed' });
    const { bus } = harness(spawn);

    const btw = await bus.execute('/btw 当前状态');
    const review = await bus.execute('/review src');

    expect(btw.completionStatus).toBe('cancelled');
    expect(review.completionStatus).toBe('failed');
  });

  it('/delegate 将子代理终态同时写入命令结果和任务记录', async () => {
    const spawn = vi.fn().mockResolvedValue({ ok: false, output: '执行失败', turns: 2, status: 'failed' });
    const { bus, db } = harness(spawn);

    const result = await bus.execute('/delegate 执行审计');
    const row = db.prepare(`SELECT status, output FROM tasks ORDER BY created_at DESC LIMIT 1`).get() as { status: string; output: string };

    expect(result.ok).toBe(false);
    expect(result.completionStatus).toBe('failed');
    expect(row).toEqual({ status: 'failed', output: '执行失败' });
  });
});

describe('modern /delegate 命令入口', () => {
  const modern = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = process.env.WXNODUS_COMPOSITION_ROOT;
    process.env.WXNODUS_COMPOSITION_ROOT = 'modern';
    try { return await operation(); } finally {
      if (previous === undefined) delete process.env.WXNODUS_COMPOSITION_ROOT;
      else process.env.WXNODUS_COMPOSITION_ROOT = previous;
    }
  };

  it('start 立即返回 receipt，并透传 parent RunContext 与 signal', async () => modern(async () => {
    const start = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        taskId: 'sub-1', processId: 99, goal: 'inspect', worktreePath: 'C:/work/sub-1', startedAt: 1, status: 'running',
        runContext: createRunContext({ runId: 'delegate:sub-1', correlationId: 'corr-1', sessionId: 's1' }),
      },
    });
    const manager = { start, stop: vi.fn(), listActive: () => [], setPaused() {}, isPaused: () => false, shutdown: vi.fn() } as any;
    const { bus } = harness(vi.fn(), {}, manager);
    const parent = createRunContext({ runId: 'command-1', correlationId: 'corr-1', sessionId: 's1' });
    const controller = new AbortController();

    const result = await bus.execute('/delegate inspect', { signal: controller.signal, runContext: parent });

    expect(result).toMatchObject({ ok: true, completionStatus: 'succeeded' });
    expect(result.output).toContain('sub-1');
    expect(start).toHaveBeenCalledWith({ goal: 'inspect', parentContext: parent, sessionId: 's1', signal: controller.signal });
  }));

  it('status 和 stop 使用同一 manager 活动表与定向终止端口', async () => modern(async () => {
    const stop = vi.fn().mockResolvedValue({ ok: true, taskId: 'sub-1', status: 'cancelled' });
    const manager = {
      start: vi.fn(), stop,
      listActive: () => [{ taskId: 'sub-1', processId: 99, goal: 'inspect', worktreePath: 'C:/work/sub-1', startedAt: 1, status: 'running', runContext: createRunContext({ runId: 'delegate:sub-1', correlationId: 'c', sessionId: 's' }) }],
      setPaused() {}, isPaused: () => false, shutdown: vi.fn(),
    } as any;
    const { bus } = harness(vi.fn(), {}, manager);

    expect((await bus.execute('/delegate --status')).output).toContain('sub-1');
    expect(await bus.execute('/delegate --stop sub-1')).toMatchObject({ ok: true, completionStatus: 'succeeded' });
    expect(stop).toHaveBeenCalledWith('sub-1');
  }));

  it('一次性宿主拒绝启动 live process，且不取得 manager 所有权', async () => modern(async () => {
    const start = vi.fn();
    const manager = { start, stop: vi.fn(), listActive: () => [], setPaused() {}, isPaused: () => false, shutdown: vi.fn() } as any;

    // 独立一次性上下文验证生产 -p 门禁。
    const dataDir = mkdtempSync(join(tmpdir(), 'wx-nested-command-oneshot-'));
    dirs.push(dataDir);
    const db = openDB(dataDir);
    dbs.push(db);
    const oneShot = createCommandBus();
    registerExtHandlers(oneShot, {
      dataDir, cwd: dataDir, db, mem: createMemory(db), bus: createEventBus(dataDir),
      config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined },
      agent: { spawnSubagent: vi.fn(), run: vi.fn(), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1' },
      getModel: () => '', getMode: () => 'smart', setMode() {}, setTheme() {}, getThemeName: () => 'wxnodus',
      requestExit() {}, clearHistory() {}, setModel() {}, openModelPicker() {}, openSessions() {}, setThinking() {},
      delegateManager: manager, liveDelegateHost: false,
    } as any);

    expect(await oneShot.execute('/delegate inspect')).toMatchObject({ ok: false, completionStatus: 'blocked' });
    expect(start).not.toHaveBeenCalled();
  }));

  it('缺少 stop id、modern --agent 和 manager 缺失均 fail-closed', async () => modern(async () => {
    const manager = { start: vi.fn(), stop: vi.fn(), listActive: () => [], setPaused() {}, isPaused: () => false, shutdown: vi.fn() } as any;
    const withManager = harness(vi.fn(), {}, manager).bus;
    expect(await withManager.execute('/delegate --stop')).toMatchObject({ ok: false, completionStatus: 'failed' });
    expect(await withManager.execute('/delegate inspect --agent reviewer')).toMatchObject({ ok: false, completionStatus: 'blocked' });

    const withoutManager = harness(vi.fn()).bus;
    expect(await withoutManager.execute('/delegate inspect')).toMatchObject({ ok: false, completionStatus: 'blocked' });
  }));
});

describe('/arena 子代理隔离', () => {
  it('并行传入独立模型、端点和 session，且不修改共享 Agent 状态', async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;
    const spawn = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }));
    const settings = { model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' };
    const { bus, setModel, setSessionId } = harness(spawn, settings);
    const previousKey = process.env.WXNODUS_API_KEY;
    process.env.WXNODUS_API_KEY = 'test-only-key';
    const controller = new AbortController();

    try {
      const pending = bus.execute('/arena 审查实现 --model glm-4.5', { signal: controller.signal });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      const first = spawn.mock.calls[0]!;
      const second = spawn.mock.calls[1]!;
      expect(first[2]).toMatchObject({ model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' });
      expect(second[2]).toMatchObject({ model: 'glm-4.5', baseURL: 'https://open.bigmodel.cn/api/paas/v4' });
      expect(first[3]).toMatchObject({ signal: controller.signal, sessionId: expect.stringMatching(/^arena-a-/) });
      expect(second[3]).toMatchObject({ signal: controller.signal, sessionId: expect.stringMatching(/^arena-b-/) });
      expect(first[3].sessionId).not.toBe(second[3].sessionId);
      expect(setModel).not.toHaveBeenCalled();
      expect(setSessionId).not.toHaveBeenCalled();

      resolveA({ ok: true, output: '方案 A', turns: 1 });
      resolveB({ ok: false, output: '方案 B 未验证', turns: 1, status: 'incomplete' });
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.completionStatus).toBe('incomplete');
      expect(setModel).not.toHaveBeenCalled();
      expect(setSessionId).not.toHaveBeenCalled();
    } finally {
      if (previousKey === undefined) delete process.env.WXNODUS_API_KEY;
      else process.env.WXNODUS_API_KEY = previousKey;
    }
  });
});
