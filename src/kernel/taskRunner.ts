// src/kernel/taskRunner.ts — 并行任务系统（双线子任务 + 三任务并行）
// 核心：一个后台任务 = 父任务（编排器）+ 并行双线子任务（各自独立子进程/PID/日志/状态），
//       加上对话主线（主 agent 不受影响）实现三任务并行。
// 线类型：
//   shell —— detached 真子进程，stdout/stderr 流式落盘 dataDir/tasks/<id>.log，
//            超时 kill、重试退避、退出码落库
//   agent —— spawnSubagent 独立会话（与主对话完全隔离）
// 父任务 = 聚合器：并行启动全部子任务（Promise.allSettled 真实并发）→ 等待完成 →
//   全 success → success；任一 failed → failed（error 标明失败线）
// 状态机（每线独立）：queued → running → success | failed | cancelled
// 并发池 maxConcurrent（默认 2）；启动恢复：遗留 running/queued → failed(orphaned)
// 事件：jobs.created / jobs.complete（payload: id/kind/parent_id/status/exit_code/duration_ms）
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizedEnv } from './env.js';

export type TaskKind = 'shell' | 'agent' | 'parallel';
export type TaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface TaskSpec {
  /** shell：完整命令文本；agent：子代理目标；parallel：编排描述 */
  goal: string;
  kind: TaskKind;
  /** 超时毫秒（默认 600000 = 10 分钟；shell 线超时 → kill） */
  timeoutMs?: number;
  /** 失败重试次数（默认 0；指数退避 2^retry × 3s） */
  maxRetries?: number;
  /** 任务标签（/jobs list --tag 过滤、cron 关联 cron:<id>） */
  tags?: string[];
  /** shell 线工作目录（默认进程 cwd） */
  cwd?: string;
}

export interface TaskRow {
  id: string;
  goal: string;
  status: TaskStatus;
  output: string;
  created_at: number;
  done_at: number | null;
  parent_id: string;
  kind: TaskKind;
  pid: number | null;
  exit_code: number | null;
  log_file: string;
  retries: number;
  timeout_ms: number;
  tags: string;
  cwd: string;
  started_at: number | null;
  error: string;
}

export interface TaskRunnerOptions {
  db: import('../store/db.js').Db;
  bus: import('./events.js').EventBus;
  dataDir: string;
  /** P0-07：第二个参数是可撤销信号——kill 后子代理必须停止产生副作用（effect fence） */
  spawnSubagent: (goal: string, signal?: AbortSignal) => Promise<{ ok: boolean; output: string; turns: number }>;
  /** 并发线数上限（默认 2） */
  maxConcurrent?: number;
}

export interface TaskRunner {
  /** 单线任务（入队异步执行） */
  run(spec: TaskSpec, parentId?: string): string;
  /** 并行任务：父任务 + N 支线（--parallel 双线）——全部子任务同时启动 */
  runParallel(main: TaskSpec, branches: TaskSpec[]): { id: string; children: string[] };
  /** 取消：kill 父任务级联 kill 全部支线（Windows taskkill /T） */
  kill(id: string): Promise<boolean>;
  /** 重试失败任务（重新入队） */
  retry(id: string): string | null;
  /** 暂停队列中的任务（仅 queued 有效） */
  pause(id: string): boolean;
  resume(id: string): boolean;
  list(filter?: { status?: TaskStatus; tag?: string; limit?: number }): TaskRow[];
  get(id: string): TaskRow | null;
  childrenOf(id: string): TaskRow[];
  /** 启动恢复：遗留 running/queued → failed(orphaned) */
  recoverOrphans(): number;
  /** 清理已结束任务（默认保留 100 条最近） */
  clean(keep?: number): number;
  /** A25：并发上限读取（delegation.status caps 真实数据源——此前 UI 硬编码 4） */
  getMaxConcurrent(): number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function createTaskRunner(opts: TaskRunnerOptions): TaskRunner {
  const { db, bus, dataDir, spawnSubagent } = opts;
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const tasksDir = join(dataDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const queue: string[] = []; // queued 任务 FIFO
  const pausedIds = new Set<string>();
  let running = 0;
  const timers = new Map<string, NodeJS.Timeout>();
  // P0-07：agent 线的 effect fence——kill 时 abort，子代理不得继续跑完
  const agentAborts = new Map<string, AbortController>();

  const row = (id: string): TaskRow | null =>
    (db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as TaskRow | undefined) ?? null;

  // 子任务查询（父任务聚合/级联 kill 共用——工厂内部函数，返回对象复用）
  const childrenOf = (id: string): TaskRow[] =>
    db.prepare(`SELECT * FROM tasks WHERE parent_id=? ORDER BY created_at`).all(id) as TaskRow[];

  const setStatus = (id: string, status: TaskStatus, extra: Record<string, unknown> = {}): void => {
    const sets = ['status=?', ...Object.keys(extra).map(k => `${k}=?`)];
    const vals = [status, ...Object.values(extra), id];
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  };

  function create(spec: TaskSpec, parentId: string): string {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const logFile = spec.kind === 'shell' ? join(tasksDir, `${id}.log`) : '';
    db.prepare(
      `INSERT INTO tasks (id, goal, status, created_at, parent_id, kind, timeout_ms, retries, tags, cwd, log_file)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, spec.goal, 'queued', Date.now(), parentId, spec.kind,
      spec.timeoutMs ?? 600_000, spec.maxRetries ?? 0, (spec.tags ?? []).join(','), spec.cwd ?? '', logFile);
    bus.emit('jobs.created', { id, kind: spec.kind, parent_id: parentId, goal: spec.goal.slice(0, 80) });
    return id;
  }

  // ── 并发池：空闲槽位启动队首任务 ──
  function pump(): void {
    while (running < maxConcurrent && queue.length) {
      const id = queue.shift()!;
      if (pausedIds.has(id)) continue; // 暂停任务跳过（resume 时重新入队）
      const t = row(id);
      if (!t || t.status !== 'queued') continue;
      running++;
      void runTask(id).finally(() => { running--; pump(); });
    }
  }

  async function runTask(id: string): Promise<void> {
    const t = row(id);
    if (!t) return;
    setStatus(id, 'running', { started_at: Date.now() });
    try {
      if (t.kind === 'shell') await runShell(t);
      else if (t.kind === 'agent') await runAgent(t);
    } catch (e: any) {
      finish(id, 'failed', 1, '', String(e?.message ?? e).slice(0, 300));
    }
  }

  // ── shell 线：detached 真子进程 + 流式日志 + 超时 + 重试退避 ──
  function killTree(pid: number | null): void {
    if (!pid) return;
    try { process.kill(pid); } catch { /* 已退出 */ }
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
    }
  }

  async function runShell(t: TaskRow): Promise<void> {
    const logFile = t.log_file || join(tasksDir, `${t.id}.log`);
    // 流式日志：stdout/stderr 管道实时落盘 + buffer 尾部（output 落库用）
    const writer = createWriteStream(logFile);
    writer.on('error', () => { /* 日志目录被清理等场景静默（任务执行不阻断） */ });
    let buffer = '';
    const attempt = (): Promise<number> =>
      new Promise<number>(resolve => {
        const isWin = process.platform === 'win32';
        // 注意：Windows 上 `detached: true` 的 spawn 不可用（子进程立即空退出、命令不执行），
        // 故任务随主 CLI 生命周期运行；CLI 退出遗留任务 → recoverOrphans 标记 failed(orphaned)，/jobs retry 恢复
        // 退出码：powershell 追加 `; exit $LASTEXITCODE` 精确透传（否则非 0 一律归一为 1）
        const child = spawn(
          isWin ? 'powershell.exe' : 'bash',
          isWin
            ? ['-NoProfile', '-NonInteractive', '-Command', `${t.goal}; exit $LASTEXITCODE`]
            : ['-c', t.goal],
          { cwd: t.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv(), shell: false }
        );
        setStatus(t.id, 'running', { pid: child.pid ?? null });
        const onData = (d: Buffer) => {
          const s = d.toString();
          writer.write(s);
          buffer = (buffer + s).slice(-4000);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        const timer = setTimeout(() => {
          killTree(child.pid ?? null);
          resolve(124); // 超时
        }, t.timeout_ms || 600_000);
        timers.set(t.id, timer);
        child.on('error', e => {
          clearTimeout(timer);
          writer.write(`[task-runner] 启动失败: ${e.message}\n`);
          resolve(127);
        });
        child.on('close', code => {
          clearTimeout(timer);
          timers.delete(t.id);
          resolve(code ?? 1);
        });
      });

    let code = await attempt();
    let tries = 0;
    while (code !== 0 && tries < (t.retries || 0)) {
      // 审查修复：kill 后不得重试——取消的任务状态为 cancelled，重试会「复活」被取消的命令
      if (row(t.id)?.status === 'cancelled') return;
      tries++;
      setStatus(t.id, 'running', { retries: tries });
      const backoff = 3 * 2 ** (tries - 1) * 1000;
      writer.write(`\n[task-runner] 退出码 ${code}——第 ${tries} 次重试（退避 ${backoff / 1000}s）\n`);
      await sleep(backoff);
      // 审查修复（P2 竞态）：退避窗口内 kill 会置 cancelled——sleep 后、重新 spawn 前
      // 必须再查一次，否则已取消的命令在 3-24s 后仍会被真实重新执行（副作用发生）
      if (row(t.id)?.status === 'cancelled') return;
      code = await attempt();
    }
    writer.end();
    // 审查修复：kill 后收口幂等——cancelled 状态不被后续 finish 覆盖
    if (row(t.id)?.status === 'cancelled') return;
    if (code === 124) finish(t.id, 'failed', 124, buffer, '执行超时（已 kill）');
    else if (code === 0) finish(t.id, 'success', 0, buffer, '');
    else finish(t.id, 'failed', code, buffer, `退出码 ${code}`);
  }

  // ── agent 线：独立子代理会话（不污染主对话）──
  async function runAgent(t: TaskRow): Promise<void> {
    // P0-07：effect fence——kill 时 abort 撤销子代理，其副作用与迟到结果均不得落定
    const controller = new AbortController();
    agentAborts.set(t.id, controller);
    try {
      const r = await spawnSubagent(t.goal, controller.signal);
      // 审查修复：kill 后不得覆盖状态（cancelled 保持）
      if (row(t.id)?.status === 'cancelled' || controller.signal.aborted) return;
      if (r.ok) finish(t.id, 'success', 0, r.output.slice(0, 4000), '');
      else finish(t.id, 'failed', 1, r.output.slice(0, 4000), '子代理执行失败');
    } catch (e: any) {
      if (controller.signal.aborted || row(t.id)?.status === 'cancelled') return;
      finish(t.id, 'failed', 1, '', String(e?.message ?? e).slice(0, 300));
    } finally {
      agentAborts.delete(t.id);
    }
  }

  // ── 完成收口：状态/事件/通知 + 父任务聚合 ──
  function finish(id: string, status: TaskStatus, exitCode: number | null, output: string, error: string): void {
    const t = row(id);
    if (!t) return;
    setStatus(id, status, { done_at: Date.now(), exit_code: exitCode, output: (output ?? '').slice(0, 4000), error: (error ?? '').slice(0, 300) });
    bus.emit('jobs.complete', { id, kind: t.kind, status, exit_code: exitCode, parent_id: t.parent_id, duration_ms: Date.now() - t.created_at });
    if (t.parent_id) maybeSettleParent(t.parent_id);
    const dur = ((Date.now() - t.created_at) / 1000).toFixed(1);
    bus.emit('system.notice', {
      text: `后台任务 ${id} ${status === 'success' ? '✅ 完成' : status === 'failed' ? '❌ 失败' : '⏹ 已取消'}（${dur}s）——/jobs show ${id} 查看${t.log_file ? ` ｜ 日志 ${t.log_file}` : ''}`,
    });
  }

  // ── 父任务聚合：子任务全部落定 → 父任务结果 ──
  function maybeSettleParent(parentId: string): void {
    const children = childrenOf(parentId);
    if (!children.length) return;
    if (children.some(c => c.status === 'queued' || c.status === 'running')) return;
    const failed = children.find(c => c.status === 'failed');
    const cancelled = children.find(c => c.status === 'cancelled');
    const allOk = !failed && !cancelled && children.every(c => c.status === 'success');
    const summary = children.map(c => `${c.id}: ${c.status}${c.exit_code != null ? `(${c.exit_code})` : ''}`).join('\n');
    if (allOk) {
      finish(parentId, 'success', 0, summary, '');
    } else if (cancelled && !failed) {
      // 支线被取消（kill 级联）→ 父任务同样取消
      finish(parentId, 'cancelled', null, summary, '子任务已取消');
    } else {
      finish(parentId, 'failed', 1, summary, `子任务失败：${failed?.id}（${failed?.error || failed?.status}）`);
    }
  }

  return {
    run(spec, parentId = '') {
      const id = create(spec, parentId);
      queue.push(id);
      pump();
      return id;
    },

    runParallel(main, branches) {
      // 父任务（编排器，kind=parallel 不占执行槽）→ 全部子任务入队并行
      const parentId = create({ ...main, kind: 'parallel', goal: `并行任务：${main.goal.slice(0, 60)}${branches.length ? ` ＋ ${branches.length} 条支线` : ''}` }, '');
      const children = [...(main.kind === 'shell' || main.kind === 'agent' ? [main] : []), ...branches].map(b => create(b, parentId));
      for (const c of children) queue.push(c);
      pump();
      return { id: parentId, children };
    },

    async kill(id) {
      const t = row(id);
      if (!t) return false;
      if (t.kind === 'parallel') {
        // 父任务（纯编排）：级联 kill 全部支线
        for (const c of childrenOf(id)) {
          if (c.status === 'queued' || c.status === 'running') await this.kill(c.id);
        }
      } else {
        // 叶子（shell/agent 执行线）：杀进程（如有）+ 撤销 agent effect fence + 结束
        killTree(t.pid);
        const controller = agentAborts.get(id);
        if (controller) controller.abort();
        const ti = timers.get(id); if (ti) clearTimeout(ti);
        if (t.status === 'queued') {
          const qi = queue.indexOf(id); if (qi >= 0) queue.splice(qi, 1);
        }
        if (t.status === 'queued' || t.status === 'running') {
          finish(id, 'cancelled', null, t.output, '用户取消');
        }
      }
      return true;
    },

    retry(id) {
      const t = row(id);
      if (!t || t.status === 'running' || t.status === 'queued') return null;
      setStatus(id, 'queued', { pid: null, exit_code: null, error: '', done_at: null, started_at: null, output: '' });
      queue.push(id);
      pump();
      return id;
    },

    pause(id) {
      const t = row(id);
      if (!t || t.status !== 'queued') return false;
      const qi = queue.indexOf(id);
      if (qi >= 0) queue.splice(qi, 1);
      pausedIds.add(id);
      return true;
    },

    resume(id) {
      if (!pausedIds.has(id)) return false;
      pausedIds.delete(id);
      queue.push(id);
      pump();
      return true;
    },

    list(filter = {}) {
      const conds: string[] = [];
      const vals: unknown[] = [];
      if (filter.status) { conds.push('status=?'); vals.push(filter.status); }
      if (filter.tag) { conds.push(`tags LIKE ?`); vals.push(`%${filter.tag}%`); }
      const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
      const limit = Math.min(filter.limit ?? 20, 100);
      return db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC LIMIT ${limit}`).all(...vals) as TaskRow[];
    },

    get: row,
    childrenOf: (id) => db.prepare(`SELECT * FROM tasks WHERE parent_id=? ORDER BY created_at`).all(id) as TaskRow[],

    recoverOrphans() {
      const n = db.prepare(`UPDATE tasks SET status='failed', error='orphaned（进程退出遗留，可 /jobs retry）', done_at=? WHERE status IN ('queued','running')`).run(Date.now()).changes ?? 0;
      queue.length = 0;
      pausedIds.clear();
      return n;
    },

    clean(keep = 100) {
      // 保留最近 keep 条已结束任务，删除更早的（running/queued 不动）
      const r = db.prepare(
        `DELETE FROM tasks WHERE status IN ('success','failed','cancelled') AND id NOT IN (
           SELECT id FROM tasks WHERE status IN ('success','failed','cancelled') ORDER BY done_at DESC LIMIT ?
         )`
      ).run(keep);
      return r.changes ?? 0;
    },

    // A25：并发上限读取（delegation.status caps 真实数据源——此前 UI 硬编码 4）
    getMaxConcurrent(): number {
      return maxConcurrent;
    },
  };
}
