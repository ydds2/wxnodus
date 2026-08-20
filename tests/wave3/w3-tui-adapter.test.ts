// tests/wave3/w3-tui-adapter.test.ts — W3 TUI facade 第 1 步：presentation adapter 契约（RED）
// 1) 源门禁：presentation bridge（wxGateway.ts）不得再直接访问 db/agent/memory——只经窄端口 adapter
// 2) 行为契约：adapter 工厂以真实 SQLite 语义 round-trip（会话/消息/checkpoint/任务/用量/cron）
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDB, openDB } from '../../src/store/db.js';
import { createTuiPresentationAdapter, type TuiAgentPort } from '../../src/presentation/tui/tuiPresentationAdapter.js';
import { createCommandBus } from '../../src/app/CommandBus.js';
import { createEventBus } from '../../src/kernel/events.js';
import { createSessionRunCoordinator } from '../../src/application/runs/sessionRunCoordinator.js';
import { createRunInvocationPort } from '../../src/application/runs/runInvocationPort.js';

describe('W3 TUI presentation adapter source gate', () => {
  it('presentation bridge must not reach db/agent/memory directly', () => {
    const source = readFileSync('src/wxnodus-ui/wxGateway.ts', 'utf8');
    expect(source).not.toMatch(/this\.kernel\.db/);
    expect(source).not.toMatch(/this\.kernel\.agent\./);
    expect(source).not.toMatch(/this\.kernel\.mem/);
    expect(source).not.toMatch(/\bdb:\s*any\b/);
    expect(source).not.toMatch(/\bagent:\s*\{\s*$/m);
  });
});

describe('W3 TUI presentation adapter behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w3-tui-adapter-'));
  const db = openDB(dir);
  const agent: TuiAgentPort = {
    run: vi.fn(async () => ({ ok: true, text: '', turns: 1, interrupted: false })),
    abort: vi.fn(),
    steer: vi.fn(() => false),
    setSessionId: vi.fn(),
    getSessionId: () => 's1',
    setMode: vi.fn(),
    setCwd: vi.fn(),
    updateTools: vi.fn(),
    setDelegationPaused: vi.fn(),
    getDelegationPaused: () => false,
    getMaxSpawnDepth: () => 3,
    getLastPromptTokens: () => 0,
  };
  const adapter = createTuiPresentationAdapter({ db, agent });

  afterAll(() => {
    try { closeDB(db); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('sessions: create/touch/rename/list/mostRecent/branch/delete round-trip', () => {
    adapter.data.sessions.create('s1');
    adapter.data.sessions.touch('s1', 2000);
    const touched = adapter.data.sessions.list(20)[0]!;
    expect(touched).toMatchObject({ id: 's1', updated_at: 2000 });
    adapter.data.sessions.rename('s1', '标题');
    expect(adapter.data.sessions.exists('s1')).toBe(true);
    const list = adapter.data.sessions.list(20);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', title: '标题' });
    expect(adapter.data.sessions.mostRecent()?.id).toBe('s1');
    expect(adapter.data.sessions.branch('s1', 's2', '分支')).toBe(true);
    expect(adapter.data.sessions.exists('s2')).toBe(true);
    expect(adapter.data.sessions.branch('missing', 's3', 'x')).toBe(false);
    expect(adapter.data.sessions.delete('s2')).toBe(true);
    expect(adapter.data.sessions.exists('s2')).toBe(false);
    expect(adapter.data.sessions.delete('nope')).toBe(false);
  });

  it('messages: load filters archived/system, archive marks, rows/count/replace', () => {
    const ins = db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_call_id, archived, ts) VALUES (?,?,?,?,?,?)`,
    );
    ins.run('s1', 'user', '你好', null, 0, 1);
    ins.run('s1', 'assistant', '你好呀', null, 0, 2);
    ins.run('s1', 'system', 'sys', null, 0, 3);
    expect(adapter.data.messages.load('s1')).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '你好呀' },
    ]);
    const nonSys = adapter.data.messages.nonSystem('s1');
    expect(nonSys.map(m => m.role)).toEqual(['user', 'assistant']);
    adapter.data.messages.archive([nonSys[0]!.id]);
    expect(adapter.data.messages.load('s1')).toEqual([{ role: 'assistant', text: '你好呀' }]);
    expect(adapter.data.messages.count('s1')).toBe(3);
    expect(adapter.data.messages.rows('s1')).toHaveLength(2); // role!='system'
    adapter.data.messages.replace('s1', [{ role: 'user', content: '新' }]);
    expect(adapter.data.messages.count('s1')).toBe(1);
    expect(adapter.data.messages.load('s1')).toEqual([{ role: 'user', text: '新' }]);
  });

  it('checkpoints: save/list/get', () => {
    const id = adapter.data.checkpoints.save('s1', { kind: 'undo-snapshot', messages: [], ts: 1 });
    expect(id).toBeGreaterThan(0);
    const list = adapter.data.checkpoints.list('s1', 20);
    expect(list).toHaveLength(1);
    expect(adapter.data.checkpoints.get(id, 's1')?.id).toBe(id);
    expect(adapter.data.checkpoints.get(id, 'other')).toBeUndefined();
  });

  it('tasks: insert/markDone/markAllRunningDone/hasRunningOrQueued', () => {
    adapter.data.tasks.insert('t1', '目标');
    adapter.data.tasks.insert('t2', '目标2');
    // hasRunningOrQueued 按 parent_id 判定（taskRunner 建任务时写 parent_id=session）
    db.prepare(`UPDATE tasks SET parent_id='s1' WHERE id='t1'`).run();
    expect(adapter.data.tasks.hasRunningOrQueued('s1')).toBe(true);
    adapter.data.tasks.markDone('t1', '输出');
    expect(adapter.data.tasks.markAllRunningDone()).toBe(1);
    expect(adapter.data.tasks.hasRunningOrQueued('s1')).toBe(false);
  });

  it('usage: get + compressions; cron falls back to empty on missing rows', () => {
    db.prepare(`INSERT INTO usage_stats (session_id, input_tokens, output_tokens, ts) VALUES (?,?,?,?)`).run('s1', 10, 5, Date.now());
    expect(adapter.data.usage.get('s1')).toMatchObject({ calls: 1, input: 10, output: 5 });
    expect(adapter.data.usage.compressions('s1')).toBe(0);
    // COUNT(*) 无行返回零行（语义与迁移前一致：未知会话 → 全零而非 undefined）
    expect(adapter.data.usage.get('nope')).toMatchObject({ calls: 0, input: 0, output: 0 });
    expect(adapter.data.cron.list()).toEqual([]);
  });

  it('usage: cost_usd 按模型聚合估算（全定价才给；未知模型省略；空会话不给）', () => {
    const now = Date.now();
    // 全定价模型 → 合计估算（deepseek-chat 1M/1M = 0.70 + glm-4-flash 免费）
    db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('s2', 'deepseek-chat', 1_000_000, 1_000_000, now);
    db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('s2', 'glm-4-flash', 100, 100, now);
    expect(adapter.data.usage.get('s2')!.cost_usd).toBeCloseTo(0.7, 6);
    // 混入未知定价模型 → 省略 cost_usd（诚实：不显示被低估的合计）
    db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('s2', 'mystery-model', 10, 10, now);
    expect(adapter.data.usage.get('s2')!.cost_usd).toBeUndefined();
    // 空会话（无调用）→ 不给 cost_usd（无噪音 $0）
    expect(adapter.data.usage.get('nope')!.cost_usd).toBeUndefined();
  });

  it('agent port passes through to the injected agent', async () => {
    adapter.agent.setSessionId('s9');
    expect(agent.setSessionId).toHaveBeenCalledWith('s9');
    adapter.agent.abort();
    expect(agent.abort).toHaveBeenCalledOnce();
    await adapter.agent.run('hi');
    expect(agent.run).toHaveBeenCalledWith('hi');
    expect(adapter.agent.getMaxSpawnDepth()).toBe(3);
  });

  it('sessions.ensure: passthrough, fail-closed code, and compatibility default', async () => {
    const calls: string[] = [];
    const wired = createTuiPresentationAdapter({
      db, agent,
      ensureSession: async sid => { calls.push(sid); return { ok: true as const }; },
    });
    expect(await wired.data.sessions.ensure('s1')).toEqual({ ok: true });
    expect(calls).toEqual(['s1']);

    const failing = createTuiPresentationAdapter({
      db, agent,
      ensureSession: async () => ({ ok: false as const, code: 'SESSION_START_INVALID' }),
    });
    expect(await failing.data.sessions.ensure('s1')).toEqual({ ok: false, code: 'SESSION_START_INVALID' });

    // 无端口（测试/legacy 组合根）→ 兼容通过，不阻断会话流程
    expect(await adapter.data.sessions.ensure('s1')).toEqual({ ok: true });
  });

  it('session.create refuses artifact-less sessions (fail-closed, no row)', async () => {
    const { GatewayClient } = await import('../../src/wxnodus-ui/wxGateway.js');
    const bus = createEventBus(dir);
    const commandBus = createCommandBus();
    let sessionId = 's1';
    const runAgent = {
      ...agent,
      getSessionId: () => sessionId,
      setSessionId: (id: string) => { sessionId = id; },
    };
    const gw = new GatewayClient({
      dataDir: dir,
      cwd: process.cwd(),
      bus,
      config: { get: () => ({}), getKey: () => undefined },
      settings: {},
      commandBus,
      runInvocation: createRunInvocationPort({
        coordinator: createSessionRunCoordinator({ agent: runAgent, bus }),
        agent: runAgent,
        executeCommand: (input, context) => commandBus.execute(input, context),
      }),
      adapter: createTuiPresentationAdapter({
        db, agent: runAgent,
        ensureSession: async () => ({ ok: false as const, code: 'SESSION_START_INVALID' }),
      }),
    } as never);
    gw.start();
    const before = (db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c;
    const r = await gw.request('session.create', {}) as { ok?: boolean; message?: string };
    expect(r.ok).toBe(false);
    expect(r.message).toContain('SESSION_START_INVALID');
    expect((db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c).toBe(before);
    expect(bus.history().filter(event => event.type === 'run.final')).toEqual([
      expect.objectContaining({ sessionId: 's1', payload: expect.objectContaining({ status: 'failed' }) }),
    ]);
  });
});

describe('sessions.list 成本列', () => {
  it('全定价给 cost_usd；混入未知模型省略（诚实）', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'w3-tui-adapter-'));
    const db2 = openDB(d2);
    const a2 = createTuiPresentationAdapter({ db: db2, agent: { run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, steer: () => false, setSessionId() {}, getSessionId: () => 's1', setMode() {}, setCwd() {}, updateTools() {}, setDelegationPaused() {}, getDelegationPaused: () => false, getMaxSpawnDepth: () => 3, getLastPromptTokens: () => 0 } });
    try {
      const now = Date.now();
      a2.data.sessions.create('s-c1');
      a2.data.sessions.create('s-c2');
      db2.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('s-c1', 'deepseek-chat', 1_000_000, 1_000_000, now);
      db2.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`).run('s-c2', 'mystery', 100, 100, now);
      const rows = a2.data.sessions.list(10);
      const c1 = rows.find(r => r.id === 's-c1')!;
      const c2 = rows.find(r => r.id === 's-c2')!;
      expect(c1.cost_usd).toBeCloseTo(0.7, 4);
      expect(c2.cost_usd).toBeUndefined();
    } finally {
      closeDB(db2);
    }
  });
});
