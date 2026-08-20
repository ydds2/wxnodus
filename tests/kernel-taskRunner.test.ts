// tests/kernel-taskRunner.test.ts — 并行任务系统（双线子任务 + 三任务并行）
// 验证：真 3 进程并行（时间重叠）、父任务聚合、独立日志、超时 kill、重试退避、
//       孤儿恢复、取消、事件通知
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createTaskRunner } from '../src/kernel/taskRunner.js';
import { createRunContext, isSessionIdentifier, type RunContext } from '../src/protocol/runs.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-tr-'));
  db = openDB(dir);
  bus = createEventBus(dir);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

function makeRunner(maxConcurrent = 4) {
  return createTaskRunner({
    db, bus, dataDir: dir,
    spawnSubagent: async (goal) => ({ ok: true, output: `子代理完成：${goal.slice(0, 40)}`, turns: 1 }),
    maxConcurrent,
  });
}

const longShellCommand = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10';

const waitFor = async (fn: () => boolean, timeoutMs = 15_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
};

describe('shell 线：真子进程执行', () => {
  it('单任务：命令真实执行、退出码/日志落库', async () => {
    const tr = makeRunner();
    // 路径转正斜杠：JS 字符串里反斜杠会被 node -e 当转义符吞掉
    const outFile = join(dir, 'out1.txt').replace(/\\/g, '/');
    const id = tr.run({ goal: `node -e "require('fs').writeFileSync('${outFile}','hello-task')"`, kind: 'shell' });
    expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);
    const t = tr.get(id)!;
    expect(t.exit_code).toBe(0);
    expect(readFileSync(join(dir, 'out1.txt'), 'utf8')).toBe('hello-task');
    expect(t.log_file).toContain(`${id}.log`);
    expect(t.pid).toBeGreaterThan(0);
  });

  it('非零退出码 → failed + error 记录', async () => {
    const tr = makeRunner();
    const id = tr.run({ goal: `node -e "process.exit(3)"`, kind: 'shell' });
    expect(await waitFor(() => tr.get(id)?.status === 'failed')).toBe(true);
    expect(tr.get(id)!.exit_code).toBe(3);
    expect(tr.get(id)!.error).toContain('退出码');
  });
});

describe('并行双线子任务（三任务并行）', () => {
  it('父任务 + 2 支线真并行：总耗时 ≈ 单线耗时（时间重叠证明并发）', async () => {
    const tr = makeRunner();
    const t0 = Date.now();
    // 三线各睡眠 2s——串行需 6s+，并行应 ≈ 2s
    const { id, children } = tr.runParallel(
      { goal: `node -e "setTimeout(()=>{},2000)"`, kind: 'shell' },
      [
        { goal: `node -e "setTimeout(()=>{},2000)"`, kind: 'shell' },
        { goal: `node -e "setTimeout(()=>{},2000)"`, kind: 'shell' },
      ]
    );
    expect(children).toHaveLength(3); // 主线（main）+ 2 条支线 = 3 条执行线并行
    const done = await waitFor(() => tr.get(id)?.status === 'success', 15_000);
    const elapsed = Date.now() - t0;
    expect(done).toBe(true);
    // 并行：总耗时应明显小于串行和（12s：主线 6s + 支线各 6s 若串行），
    // 8s 阈值（全量并行负载余量）——仍严格证明并发（串行必然 ≥12s）
    expect(elapsed).toBeLessThan(8000);
    // 三线全部 success
    for (const c of children) expect(tr.get(c)!.status).toBe('success');
  });

  it('父任务聚合：任一子任务失败 → 父 failed 并标明失败线', async () => {
    const tr = makeRunner();
    const { id, children } = tr.runParallel(
      { goal: `node -e "setTimeout(()=>{},500)"`, kind: 'shell' },
      [{ goal: `node -e "process.exit(7)"`, kind: 'shell' }]
    );
    expect(await waitFor(() => tr.get(id)?.status === 'failed')).toBe(true);
    expect(tr.get(id)!.error).toContain('子任务失败');
    expect(tr.get(id)!.error).toContain(children[1]!); // 失败线 id 明确标记
    expect(tr.get(children[1]!)!.exit_code).toBe(7);
  });

  it('双线独立日志文件（互不干扰）', async () => {
    const tr = makeRunner();
    const { children } = tr.runParallel(
      { goal: `node -e "console.log('主线输出')"`, kind: 'shell' },
      [{ goal: `node -e "console.log('支线输出')"`, kind: 'shell' }]
    );
    // 并行双线：须等两条支线都落定再读日志（此前只等 children[0]——支线 B 尚未写完即读，读空文件 flake）
    expect(await waitFor(() => tr.get(children[0]!)?.status === 'success')).toBe(true);
    expect(await waitFor(() => tr.get(children[1]!)?.status === 'success')).toBe(true);
    const logA = tr.get(children[0]!)!.log_file;
    const logB = tr.get(children[1]!)!.log_file;
    expect(logA).not.toBe(logB);
    expect(readFileSync(logA, 'utf8')).toContain('主线输出');
    expect(readFileSync(logB, 'utf8')).toContain('支线输出');
  });
});

describe('agent 线（子代理独立会话）', () => {
  it('agent 型任务：spawnSubagent 调用 + success', async () => {
    let called = '';
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (goal) => { called = goal; return { ok: true, output: '完成', turns: 2 }; },
    });
    const id = tr.run({ goal: '检查项目健康', kind: 'agent' });
    expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);
    expect(called).toContain('检查项目健康');
    expect(tr.get(id)!.output).toContain('完成');
  });
});

describe('agent Run 生命周期', () => {
  it('成功任务获得冻结身份，created/complete/final 归属同一 Run 且 final 唯一', async () => {
    let context: RunContext | undefined;
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, _signal, received) => {
        context = received;
        return { ok: true, output: '完成', turns: 2 };
      },
    });
    const id = tr.run({ goal: '检查项目健康', kind: 'agent' });
    expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);

    expect(context).toBeDefined();
    expect(Object.isFrozen(context)).toBe(true);
    expect(isSessionIdentifier(context!.sessionId)).toBe(true);
    const events = bus.history().filter(event => event.payload?.id === id || event.runId === context!.runId);
    expect(events.filter(event => event.type === 'jobs.created')).toHaveLength(1);
    expect(events.filter(event => event.type === 'jobs.complete')).toHaveLength(1);
    expect(events.filter(event => event.type === 'run.final')).toHaveLength(1);
    expect(events.every(event => event.runId === context!.runId)).toBe(true);
    expect(events.find(event => event.type === 'run.final')?.payload.status).toBe('succeeded');
  });

  it('封存执行 scope 和 final 监听器派生的异步事件', async () => {
    let runId = '';
    const operationMarker = `late-operation-${Date.now()}`;
    const listenerMarker = `late-listener-${Date.now()}`;
    const off = bus.on('run.final', event => {
      if (event.runId !== runId) return;
      setTimeout(() => bus.emit('agent.token', { marker: listenerMarker }), 0);
    });
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, _signal, context) => {
        runId = context.runId;
        setTimeout(() => bus.emit('agent.token', { marker: operationMarker }), 0);
        return { ok: true, output: '完成', turns: 1 };
      },
    });

    try {
      const id = tr.run({ goal: 'scope seal', kind: 'agent' });
      expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 20));

      for (const marker of [operationMarker, listenerMarker]) {
        const event = bus.history().find(candidate => candidate.payload?.marker === marker);
        expect(event).toBeDefined();
        expect(event?.runId).toBeUndefined();
      }
    } finally {
      off();
    }
  });

  it('子代理失败只产生一个 failed final', async () => {
    let runId = '';
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, _signal, context) => {
        runId = context.runId;
        throw new Error('child failed');
      },
    });
    const id = tr.run({ goal: '失败任务', kind: 'agent' });
    expect(await waitFor(() => tr.get(id)?.status === 'failed')).toBe(true);
    const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === runId);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload).toMatchObject({ status: 'failed', error: 'child failed' });
  });

  it('运行中取消后迟到成功不得覆盖状态或产生第二个 final', async () => {
    let context: RunContext | undefined;
    let release!: () => void;
    const child = new Promise<void>(resolve => { release = resolve; });
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, _signal, received) => {
        context = received;
        await child;
        return { ok: true, output: '迟到成功', turns: 1 };
      },
    });
    const id = tr.run({ goal: '长任务', kind: 'agent' });
    expect(await waitFor(() => tr.get(id)?.status === 'running')).toBe(true);
    expect(await tr.kill(id)).toBe(true);
    release();
    expect(await waitFor(() => bus.history().some(event => event.type === 'run.final' && event.runId === context?.runId))).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(tr.get(id)?.status).toBe('cancelled');
    const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === context!.runId);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload.status).toBe('cancelled');
  });

  it('排队任务取消不启动子代理且仍产生唯一 cancelled final', async () => {
    let firstRelease!: () => void;
    const firstChild = new Promise<void>(resolve => { firstRelease = resolve; });
    const started: string[] = [];
    const tr = createTaskRunner({
      db, bus, dataDir: dir, maxConcurrent: 1,
      spawnSubagent: async (goal) => {
        started.push(goal);
        if (goal === '占用槽位') await firstChild;
        return { ok: true, output: goal, turns: 1 };
      },
    });
    const first = tr.run({ goal: '占用槽位', kind: 'agent' });
    expect(await waitFor(() => tr.get(first)?.status === 'running')).toBe(true);
    const queued = tr.run({ goal: '不得启动', kind: 'agent' });
    const created = bus.history().find(event => event.type === 'jobs.created' && event.payload.id === queued)!;

    expect(await tr.kill(queued)).toBe(true);
    expect(tr.get(queued)?.status).toBe('cancelled');
    expect(started).toEqual(['占用槽位']);
    const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === created.runId);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload.status).toBe('cancelled');
    firstRelease();
  });

  it('retry 为同一任务创建新的 Run 身份', async () => {
    let calls = 0;
    const runIds: string[] = [];
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, _signal, context) => {
        calls++;
        runIds.push(context.runId);
        return calls === 1
          ? { ok: false, output: '首次失败', turns: 1 }
          : { ok: true, output: '重试成功', turns: 1 };
      },
    });
    const id = tr.run({ goal: '可重试任务', kind: 'agent' });
    expect(await waitFor(() => tr.get(id)?.status === 'failed')).toBe(true);
    expect(tr.retry(id)).toBe(id);
    expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);
    expect(runIds).toHaveLength(2);
    expect(runIds[1]).not.toBe(runIds[0]);
    for (const runId of runIds) {
      expect(bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
    }
  });

  it('超时会 abort 且不等待忽略取消的子代理返回', async () => {
    let signal: AbortSignal | undefined;
    let runId = '';
    const never = new Promise<never>(() => {});
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, received, context) => {
        signal = received;
        runId = context.runId;
        return never;
      },
    });
    const id = tr.run({ goal: '忽略取消', kind: 'agent', timeoutMs: 50 });

    expect(await waitFor(() => tr.get(id)?.status === 'failed', 2_000)).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(tr.get(id)).toMatchObject({ exit_code: 124 });
    expect(tr.get(id)?.error).toContain('超时');
    const finals = bus.history().filter(event => event.type === 'run.final' && event.runId === runId);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload.status).toBe('failed');
  });

  it('超时后的迟到成功不得覆盖状态或产生第二个 final', async () => {
    let release!: () => void;
    let runId = '';
    const child = new Promise<void>(resolve => { release = resolve; });
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, _signal, context) => {
        runId = context.runId;
        await child;
        return { ok: true, output: '迟到成功', turns: 1 };
      },
    });
    const id = tr.run({ goal: '迟到任务', kind: 'agent', timeoutMs: 50 });
    expect(await waitFor(() => tr.get(id)?.status === 'failed', 2_000)).toBe(true);
    release();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(tr.get(id)?.status).toBe('failed');
    expect(bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
  });

  it('正常完成后清除 timeout，不会稍后误 abort 已完成信号', async () => {
    let signal: AbortSignal | undefined;
    const tr = createTaskRunner({
      db, bus, dataDir: dir,
      spawnSubagent: async (_goal, received) => {
        signal = received;
        return { ok: true, output: '完成', turns: 1 };
      },
    });
    const id = tr.run({ goal: '快速完成', kind: 'agent', timeoutMs: 50 });
    expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(signal?.aborted).toBe(false);
  });
});

describe('超时与重试', () => {
  it('超时 kill：超过 timeoutMs → failed(超时)', async () => {
    const tr = makeRunner();
    const id = tr.run({ goal: `node -e "setTimeout(()=>{},10000)"`, kind: 'shell', timeoutMs: 600 });
    expect(await waitFor(() => tr.get(id)?.status === 'failed', 10_000)).toBe(true);
    expect(tr.get(id)!.error).toContain('超时');
  });

  it('重试：首次失败第二次成功（maxRetries 生效）', async () => {
    const tr = makeRunner();
    const flag = join(dir, 'retry-flag.txt');
    const id = tr.run({
      goal: `node -e "const f=require('fs');const p='${flag.replace(/\\/g, '/')}';const n=(f.existsSync(p)?Number(f.readFileSync(p,'utf8')||'0'):0)+1;f.writeFileSync(p,String(n));process.exit(n<2?1:0)"`,
      kind: 'shell',
      maxRetries: 2,
    });
    expect(await waitFor(() => tr.get(id)?.status === 'success', 20_000)).toBe(true);
    expect(tr.get(id)!.retries).toBe(1); // 失败 1 次后重试成功
  });
});

describe('生命周期管理', () => {
  it('shutdown 同步封禁新准入、幂等，并排空 running/queued/paused 所有权', async () => {
    const never = new Promise<never>(() => {});
    let agentSignal: AbortSignal | undefined;
    const tr = createTaskRunner({
      db, bus, dataDir: dir, maxConcurrent: 2,
      spawnSubagent: async (_goal, signal) => {
        agentSignal = signal;
        return never;
      },
    });
    const runningAgent = tr.run({ goal: '运行中的代理', kind: 'agent' });
    const runningShell = tr.run({ goal: longShellCommand, kind: 'shell' });
    expect(await waitFor(() => tr.get(runningAgent)?.status === 'running' && (tr.get(runningShell)?.pid ?? 0) > 0)).toBe(true);
    const shellPid = tr.get(runningShell)!.pid!;
    const queued = tr.run({ goal: '排队任务', kind: 'agent' });
    const paused = tr.run({ goal: '暂停任务', kind: 'agent' });
    expect(tr.pause(paused)).toBe(true);

    const firstShutdown = tr.shutdown('test teardown');
    const secondShutdown = tr.shutdown('ignored duplicate reason');
    expect(secondShutdown).toBe(firstShutdown);

    const admissionErrors = [
      () => tr.run({ goal: 'late', kind: 'agent' }),
      () => tr.runParallel({ goal: 'late parent', kind: 'agent' }, []),
      () => tr.retry(queued),
      () => tr.resume(paused),
    ].map(admit => {
      try { admit(); } catch (error) { return error; }
      return undefined;
    });
    expect(admissionErrors.every(error => error instanceof Error)).toBe(true);
    expect(new Set(admissionErrors.map(error => (error as Error).message))).toEqual(new Set(['TASK_RUNNER_SHUT_DOWN']));

    await firstShutdown;
    expect(agentSignal?.aborted).toBe(true);
    expect(() => process.kill(shellPid, 0)).toThrow();
    for (const id of [runningAgent, runningShell, queued, paused]) {
      expect(tr.get(id)?.status).toBe('cancelled');
      const runId = bus.history().find(event => event.type === 'jobs.created' && event.payload.id === id)?.runId;
      expect(bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
    }
  });

  it('shell shutdown 不在进程树物理退出前报告 cancelled final', async () => {
    const tr = makeRunner();
    const id = tr.run({ goal: longShellCommand, kind: 'shell' });
    expect(await waitFor(() => (tr.get(id)?.pid ?? 0) > 0)).toBe(true);
    const pid = tr.get(id)!.pid!;
    const runId = bus.history().find(event => event.type === 'jobs.created' && event.payload.id === id)?.runId;

    const shutdown = tr.shutdown('shell ownership test');
    const earlyFinal = bus.history().find(event => event.type === 'run.final' && event.runId === runId);
    if (earlyFinal) expect(() => process.kill(pid, 0)).toThrow();
    await shutdown;

    expect(() => process.kill(pid, 0)).toThrow();
    expect(tr.get(id)?.status, tr.get(id)?.error).toBe('cancelled');
    expect(bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
  });

  it('kill 运行中任务 → cancelled（级联 kill 支线）', async () => {
    const tr = makeRunner();
    const { id, children } = tr.runParallel(
      { goal: longShellCommand, kind: 'shell' },
      [{ goal: longShellCommand, kind: 'shell' }]
    );
    expect(await waitFor(() => tr.get(children[0]!)?.status === 'running')).toBe(true);
    await tr.kill(id);
    expect(await waitFor(() => tr.get(id)?.status === 'cancelled')).toBe(true);
    for (const c of children) expect(tr.get(c)!.status).toBe('cancelled'); // 级联
  });

  it('shutdown 取消处于重试退避期、当前没有子进程的 shell 任务', async () => {
    const tr = makeRunner();
    const id = tr.run({ goal: `node -e "process.exit(1)"`, kind: 'shell', maxRetries: 2 });
    expect(await waitFor(() => tr.get(id)?.status === 'running' && tr.get(id)?.retries === 1)).toBe(true);

    await tr.shutdown('retry backoff shutdown');

    expect(tr.get(id)?.status).toBe('cancelled');
    const runId = bus.history().find(event => event.type === 'jobs.created' && event.payload.id === id)?.runId;
    expect(bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
    expect(bus.history().find(event => event.type === 'run.final' && event.runId === runId)?.payload.status).toBe('cancelled');
  });

  it('shell 终止无法在截止时间内确认时有界返回 failed，而非虚假 cancelled', async () => {
    const tr = makeRunner();
    const id = tr.run({ goal: `node -e "setTimeout(()=>{},10000)"`, kind: 'shell' });
    expect(await waitFor(() => (tr.get(id)?.pid ?? 0) > 0)).toBe(true);
    const startedAt = Date.now();

    await tr.shutdown('bounded termination test');

    expect(Date.now() - startedAt).toBeLessThan(7_000);
    expect(tr.get(id)).toMatchObject({ status: 'failed', exit_code: 125 });
    expect(tr.get(id)?.error).toContain('未确认 taskkill 与 child close');
    const runId = bus.history().find(event => event.type === 'jobs.created' && event.payload.id === id)?.runId;
    expect(bus.history().filter(event => event.type === 'run.final' && event.runId === runId)).toHaveLength(1);
    expect(bus.history().find(event => event.type === 'run.final' && event.runId === runId)?.payload.status).toBe('failed');
  });

  it('孤儿恢复：遗留 running/queued → failed(orphaned)', async () => {
    const tr = makeRunner();
    db.prepare(`INSERT INTO tasks (id, goal, status, created_at, parent_id, kind) VALUES (?,?,?,?,?,?)`)
      .run('orphan1', '遗留任务', 'running', Date.now(), '', 'shell');
    db.prepare(`INSERT INTO tasks (id, goal, status, created_at, parent_id, kind) VALUES (?,?,?,?,?,?)`)
      .run('orphan2', '遗留排队', 'queued', Date.now(), '', 'shell');
    const n = tr.recoverOrphans();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(tr.get('orphan1')!.status).toBe('failed');
    expect(tr.get('orphan1')!.error).toContain('orphaned');
  });

  it('retry 失败任务重新入队执行', async () => {
    const tr = makeRunner();
    const id = tr.run({ goal: `node -e "process.exit(9)"`, kind: 'shell' });
    expect(await waitFor(() => tr.get(id)?.status === 'failed')).toBe(true);
    expect(tr.retry(id)).toBe(id);
    expect(await waitFor(() => tr.get(id)?.status === 'failed', 15_000)).toBe(true); // 再次失败（命令固定失败）
    expect(tr.get(id)!.retries).toBe(0); // retry 不累计 maxRetries
  });
});

describe('事件与并发池', () => {
  it('jobs.created / jobs.complete 事件广播', async () => {
    const events: string[] = [];
    const off1 = bus.on('jobs.created', (e: any) => events.push(`created:${e.payload.id}`));
    const off2 = bus.on('jobs.complete', (e: any) => events.push(`complete:${e.payload.id}:${e.payload.status}`));
    try {
      const tr = makeRunner();
      const id = tr.run({ goal: `node -e "console.log('x')"`, kind: 'shell' });
      expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);
      expect(events.some(e => e === `created:${id}`)).toBe(true);
      expect(events.some(e => e === `complete:${id}:success`)).toBe(true);
    } finally { off1(); off2(); }
  });

  it('shell 后台任务不继承已完成的前台 Run 身份', async () => {
    const foreground = createRunContext({
      runId: 'foreground:completed',
      correlationId: 'foreground:correlation',
      sessionId: 'foreground-session',
    });
    const tr = makeRunner();
    const id = await bus.withinRun(foreground, async () =>
      tr.run({ goal: `node -e "console.log('isolated')"`, kind: 'shell' })
    );
    expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);

    const events = bus.history().filter(event => event.payload?.id === id || (
      event.type === 'run.final' && event.payload?.runId?.startsWith(`task:${id}:`)
    ));
    const runIds = new Set(events.map(event => event.runId));
    expect(runIds.size).toBe(1);
    expect(runIds.has(foreground.runId)).toBe(false);
    expect(events.filter(event => event.type === 'run.final')).toHaveLength(1);
    expect(events.find(event => event.type === 'run.final')?.payload.status).toBe('succeeded');
  });

  it('parallel 父任务和每条支线各有独立且唯一的 final', async () => {
    const tr = makeRunner();
    const { id, children } = tr.runParallel(
      { goal: `node -e "console.log('main')"`, kind: 'shell' },
      [{ goal: `node -e "console.log('branch')"`, kind: 'shell' }],
    );
    expect(await waitFor(() => tr.get(id)?.status === 'success')).toBe(true);

    for (const taskId of [id, ...children]) {
      const created = bus.history().find(event => event.type === 'jobs.created' && event.payload.id === taskId);
      expect(created?.runId).toBeTruthy();
      expect(bus.history().filter(event => event.type === 'run.final' && event.runId === created?.runId)).toHaveLength(1);
    }
    const createdRunIds = [id, ...children].map(taskId =>
      bus.history().find(event => event.type === 'jobs.created' && event.payload.id === taskId)?.runId
    );
    expect(new Set(createdRunIds).size).toBe(createdRunIds.length);
  });

  it('并发池：maxConcurrent=1 时任务串行执行（时间不重叠）', async () => {
    const tr = makeRunner(1);
    const t0 = Date.now();
    const a = tr.run({ goal: `node -e "setTimeout(()=>{},1200)"`, kind: 'shell' });
    const b = tr.run({ goal: `node -e "setTimeout(()=>{},1200)"`, kind: 'shell' });
    expect(await waitFor(() => tr.get(b)?.status === 'success', 15_000)).toBe(true);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2200); // 串行：2×1.2s
    expect(tr.get(a)!.status).toBe('success');
  });
});
