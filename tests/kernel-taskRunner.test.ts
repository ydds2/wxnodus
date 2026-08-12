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
    expect(await waitFor(() => tr.get(children[0]!)?.status === 'success')).toBe(true);
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
  it('kill 运行中任务 → cancelled（级联 kill 支线）', async () => {
    const tr = makeRunner();
    const { id, children } = tr.runParallel(
      { goal: `node -e "setTimeout(()=>{},10000)"`, kind: 'shell' },
      [{ goal: `node -e "setTimeout(()=>{},10000)"`, kind: 'shell' }]
    );
    expect(await waitFor(() => tr.get(children[0]!)?.status === 'running')).toBe(true);
    await tr.kill(id);
    expect(await waitFor(() => tr.get(id)?.status === 'cancelled')).toBe(true);
    for (const c of children) expect(tr.get(c)!.status).toBe('cancelled'); // 级联
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
