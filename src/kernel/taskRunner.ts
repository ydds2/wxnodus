// src/kernel/taskRunner.ts — 并行任务系统（双线子任务 + 三任务并行）
// 核心：一个后台任务 = 父任务（编排器）+ 并行双线子任务（各自独立子进程/PID/日志/状态），
//       加上对话主线（主 agent 不受影响）实现三任务并行。
// 线类型：
//   shell —— detached 真子进程，stdout/stderr 流式落盘 dataDir/tasks/<id>.log，
//            超时 kill、重试退避、退出码落库
//   agent —— spawnSubagent 独立会话（与主对话完全隔离）
// 父任务 = 聚合器：并行启动全部子任务（Promise.allSettled 真实并发）→ 等待完成 →
//   全 success → success；任一 failed → failed（error 标明失败线）
// 状态机（每线独立）：queued → running → success | failed | cancelled；每个后台任务另有独立六终态 Run
// 并发池 maxConcurrent（默认 2）；启动恢复：遗留 running/queued → failed(orphaned)
// 事件：jobs.created / jobs.complete（payload: id/kind/parent_id/status/exit_code/duration_ms）
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizedEnv } from './env.js';
import {
  createRunContext,
  normalizeAgentRunStatus,
  type RunContext,
  type RunFinalStatus,
} from '../protocol/runs.js';

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

export interface TaskAgentResult {
  ok: boolean;
  output: string;
  turns: number;
  interrupted?: boolean;
  status?: string;
}

export interface TaskRunnerOptions {
  db: import('../store/db.js').Db;
  bus: import('./events.js').EventBus;
  dataDir: string;
  /** 每个 agent 任务获得独立 Run 身份与撤销信号，生产子代理不得丢弃任一参数。 */
  spawnSubagent: (goal: string, signal: AbortSignal, context: RunContext) => Promise<TaskAgentResult>;
  /** 并发线数上限（默认 2） */
  maxConcurrent?: number;
  /** 进程树终止确认截止（默认 5s；HC-4 测试注入——负载下竞态确定性根治） */
  terminationDeadlineMs?: number;
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
  /** 封禁新准入，取消并排空本实例拥有的全部任务。重复调用返回同一 Promise。 */
  shutdown(reason: string): Promise<void>;
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
  const shellAborts = new Map<string, AbortController>();
  const shellCancellationReasons = new Map<string, string>();
  const activeTasks = new Map<string, Promise<void>>();
  const activeShells = new Map<string, ShellExecution>();
  const admissionError = Object.assign(new Error('TASK_RUNNER_SHUT_DOWN'), { code: 'TASK_RUNNER_SHUT_DOWN' });
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  // P0-2：shell/agent/parallel 都是独立后台 Run，不得继承启动它的前台 Run 身份。
  const taskRuns = new Map<string, {
    context: RunContext;
    startedAt: number | null;
    finalized: boolean;
  }>();

  const createTaskRun = (id: string, parentId: string) => {
    taskRuns.set(id, {
      context: createRunContext({
        runId: `task:${id}:${Date.now().toString(36)}`,
        correlationId: parentId ? `task-parent:${parentId}` : `task:${id}`,
        sessionId: `task-${id.toLowerCase()}`,
      }),
      startedAt: null,
      finalized: false,
    });
  };

  const finalizeTaskRun = (
    id: string,
    status: RunFinalStatus,
    error = '',
  ): void => {
    const lifecycle = taskRuns.get(id);
    if (!lifecycle || lifecycle.finalized) return;
    lifecycle.finalized = true;
    const finishedAt = Date.now();
    const startedAt = lifecycle.startedAt ?? lifecycle.context.admittedAt;
    bus.withinRun(lifecycle.context, () => {
      bus.finalizeRun({
        runId: lifecycle.context.runId,
        correlationId: lifecycle.context.correlationId,
        sessionId: lifecycle.context.sessionId,
        status,
        admittedAt: lifecycle.context.admittedAt,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ...(error ? { error } : {}),
      });
    });
    taskRuns.delete(id);
  };

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

  function assertAccepting(): void {
    if (shuttingDown) throw admissionError;
  }

  function create(spec: TaskSpec, parentId: string): string {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const logFile = spec.kind === 'shell' ? join(tasksDir, `${id}.log`) : '';
    db.prepare(
      `INSERT INTO tasks (id, goal, status, created_at, parent_id, kind, timeout_ms, retries, tags, cwd, log_file)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, spec.goal, 'queued', Date.now(), parentId, spec.kind,
      spec.timeoutMs ?? 600_000, spec.maxRetries ?? 0, (spec.tags ?? []).join(','), spec.cwd ?? '', logFile);
    createTaskRun(id, parentId);
    const lifecycle = taskRuns.get(id)!;
    bus.withinRun(lifecycle.context, () => {
      bus.emit('jobs.created', { id, kind: spec.kind, parent_id: parentId, goal: spec.goal.slice(0, 80) });
    });
    return id;
  }

  // ── 并发池：空闲槽位启动队首任务 ──
  function pump(): void {
    if (shuttingDown) return;
    while (running < maxConcurrent && queue.length) {
      const id = queue.shift()!;
      if (pausedIds.has(id)) continue; // 暂停任务跳过（resume 时重新入队）
      const t = row(id);
      if (!t || t.status !== 'queued') continue;
      running++;
      const task = runTask(id);
      activeTasks.set(id, task);
      void task.finally(() => {
        activeTasks.delete(id);
        running--;
        pump();
      });
    }
  }

  async function runTask(id: string): Promise<void> {
    const t = row(id);
    const lifecycle = taskRuns.get(id);
    if (!t || !lifecycle) return;
    lifecycle.startedAt = Date.now();
    setStatus(id, 'running', { started_at: lifecycle.startedAt });
    try {
      await bus.withinRun(lifecycle.context, async () => {
        if (t.kind === 'shell') await runShell(t);
        else if (t.kind === 'agent') await runAgent(t);
      });
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 300);
      finish(id, 'failed', 1, '', error, 'failed');
    }
  }

  // ── shell 线：真子进程 + 流式日志 + 有界、可确认的进程树终止 ──
  type ShellTermination = { confirmed: boolean; error: string };
  type ShellAttempt = {
    code: number;
    intent?: 'cancel' | 'timeout';
    termination?: ShellTermination;
  };
  type ShellExecution = {
    child: ChildProcess;
    closed: boolean;
    closePromise: Promise<number>;
    terminationIntent?: 'cancel' | 'timeout';
    terminationPromise?: Promise<ShellTermination>;
    onTermination?: (result: ShellTermination) => void;
  };
  const TERMINATION_DEADLINE_MS = opts.terminationDeadlineMs ?? 5_000;

  function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      void promise.then(value => {
        clearTimeout(timer);
        resolve(value);
      }, () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  function beginShellTermination(execution: ShellExecution, intent: 'cancel' | 'timeout'): Promise<ShellTermination> {
    if (execution.terminationPromise) return execution.terminationPromise;
    execution.terminationIntent = intent;
    execution.terminationPromise = (async () => {
      const pid = execution.child.pid;
      if (!pid) return { confirmed: false, error: '进程树终止失败：子进程 PID 不可用' };

      let killResult: Promise<{ ok: boolean; detail: string }>;
      if (process.platform === 'win32') {
        // PowerShell can publish its PID just before the command child joins the process tree.
        await sleep(75);
        killResult = new Promise(resolve => {
          try {
            const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            let settled = false;
            const settle = (ok: boolean, detail: string) => {
              if (settled) return;
              settled = true;
              resolve({ ok, detail });
            };
            killer.once('error', error => settle(false, error.message));
            killer.once('close', code => settle(code === 0, `taskkill exit ${code ?? 'null'}`));
          } catch (error) {
            resolve({ ok: false, detail: String((error as Error)?.message ?? error) });
          }
        });
      } else {
        killResult = Promise.resolve().then(() => {
          try {
            process.kill(pid, 'SIGTERM');
            return { ok: true, detail: 'SIGTERM sent' };
          } catch (error) {
            return { ok: execution.closed, detail: String((error as Error)?.message ?? error) };
          }
        });
      }

      const completed = await bounded(Promise.all([killResult, execution.closePromise]), TERMINATION_DEADLINE_MS);
      if (!completed) {
        execution.child.stdout?.destroy();
        execution.child.stderr?.destroy();
        execution.child.unref();
        return { confirmed: false, error: `进程树终止失败：${TERMINATION_DEADLINE_MS}ms 内未确认 taskkill 与 child close` };
      }
      const [result] = completed;
      if (!result.ok) return { confirmed: false, error: `进程树终止失败：${result.detail}` };
      return { confirmed: true, error: '' };
    })();
    void execution.terminationPromise.then(result => execution.onTermination?.(result));
    return execution.terminationPromise;
  }

  async function runShell(t: TaskRow): Promise<void> {
    const logFile = t.log_file || join(tasksDir, `${t.id}.log`);
    const writer = createWriteStream(logFile);
    const writerDone = new Promise<void>(resolve => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      writer.once('finish', settle);
      writer.once('error', settle);
    });
    writer.on('error', () => { /* 日志失败不阻断任务终态。 */ });
    const controller = new AbortController();
    shellAborts.set(t.id, controller);
    let buffer = '';

    const attempt = (): Promise<ShellAttempt> => {
      const isWin = process.platform === 'win32';
      const child = spawn(
        isWin ? 'powershell.exe' : 'bash',
        isWin
          ? ['-NoProfile', '-NonInteractive', '-Command', `${t.goal}; exit $LASTEXITCODE`]
          : ['-c', t.goal],
        { cwd: t.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv(), shell: false }
      );
      setStatus(t.id, 'running', { pid: child.pid ?? null });
      const onData = (d: Buffer) => {
        const text = d.toString();
        writer.write(text);
        buffer = (buffer + text).slice(-4000);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      let closeResolve!: (code: number) => void;
      const closePromise = new Promise<number>(resolve => { closeResolve = resolve; });
      const execution: ShellExecution = { child, closed: false, closePromise };
      activeShells.set(t.id, execution);

      return new Promise<ShellAttempt>(resolve => {
        let settled = false;
        const settle = (result: ShellAttempt) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          timers.delete(t.id);
          if (activeShells.get(t.id) === execution) activeShells.delete(t.id);
          resolve(result);
        };
        execution.onTermination = termination => settle({
          code: execution.terminationIntent === 'timeout' ? 124 : 1,
          intent: execution.terminationIntent,
          termination,
        });
        const timer = setTimeout(() => {
          void beginShellTermination(execution, 'timeout');
        }, t.timeout_ms || 600_000);
        timers.set(t.id, timer);

        child.once('error', error => {
          writer.write(`[task-runner] 启动失败: ${error.message}\n`);
          if (!execution.closed) {
            execution.closed = true;
            closeResolve(127);
          }
        });
        child.once('close', code => {
          if (!execution.closed) {
            execution.closed = true;
            closeResolve(code ?? 1);
          }
        });
        void closePromise.then(async code => {
          if (execution.terminationPromise) {
            const termination = await execution.terminationPromise;
            settle({ code: execution.terminationIntent === 'timeout' ? 124 : code, intent: execution.terminationIntent, termination });
          } else {
            settle({ code });
          }
        });
      });
    };

    let outcome = await attempt();
    let tries = 0;
    while (!outcome.termination && outcome.code !== 0 && tries < (t.retries || 0)) {
      if (controller.signal.aborted) break;
      tries++;
      setStatus(t.id, 'running', { retries: tries });
      const backoff = 3 * 2 ** (tries - 1) * 1000;
      writer.write(`\n[task-runner] 退出码 ${outcome.code}——第 ${tries} 次重试（退避 ${backoff / 1000}s）\n`);
      await Promise.race([
        sleep(backoff),
        controller.signal.aborted
          ? Promise.resolve()
          : new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      if (controller.signal.aborted) break;
      outcome = await attempt();
    }

    writer.end();
    await writerDone;
    shellAborts.delete(t.id);

    if (outcome.termination) {
      if (!outcome.termination.confirmed) {
        finish(t.id, 'failed', 125, buffer, outcome.termination.error, 'failed');
      } else if (outcome.intent === 'timeout') {
        finish(t.id, 'failed', 124, buffer, '执行超时（已确认进程树终止）', 'failed');
      } else {
        finish(t.id, 'cancelled', null, buffer, shellCancellationReasons.get(t.id) ?? '用户取消', 'cancelled');
      }
    } else if (controller.signal.aborted) {
      finish(t.id, 'cancelled', null, buffer, shellCancellationReasons.get(t.id) ?? '用户取消', 'cancelled');
    } else if (outcome.code === 0) {
      finish(t.id, 'success', 0, buffer, '');
    } else {
      finish(t.id, 'failed', outcome.code, buffer, `退出码 ${outcome.code}`);
    }
    shellCancellationReasons.delete(t.id);
  }

  // ── agent 线：独立子代理会话（不污染主对话）──
  async function runAgent(t: TaskRow): Promise<void> {
    const controller = new AbortController();
    const lifecycle = taskRuns.get(t.id);
    if (!lifecycle) throw new Error(`TASK_RUN_CONTEXT_MISSING:${t.id}`);
    const timeoutMs = t.timeout_ms || 600_000;
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    timers.set(t.id, timeout);
    agentAborts.set(t.id, controller);

    type Outcome =
      | { kind: 'result'; value: TaskAgentResult }
      | { kind: 'error'; cause: unknown }
      | { kind: 'aborted' };
    const aborted = new Promise<Outcome>(resolve => {
      controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
    });
    const child: Promise<Outcome> = spawnSubagent(t.goal, controller.signal, lifecycle.context).then(
      value => ({ kind: 'result' as const, value }),
      cause => ({ kind: 'error' as const, cause }),
    );

    try {
      const outcome = await Promise.race([child, aborted]);
      const cancelled = row(t.id)?.status === 'cancelled';
      if (outcome.kind === 'aborted') {
        if (cancelled) {
          finalizeTaskRun(t.id, 'cancelled', '用户取消');
        } else {
          const error = `执行超时（${timeoutMs}ms，已取消子代理）`;
          finish(t.id, 'failed', 124, '', error, 'failed');
        }
        return;
      }
      if (cancelled) {
        finalizeTaskRun(t.id, 'cancelled', '用户取消');
        return;
      }
      if (outcome.kind === 'error') {
        const error = String((outcome.cause as Error)?.message ?? outcome.cause).slice(0, 300);
        finish(t.id, 'failed', 1, '', error, 'failed');
        return;
      }

      const r = outcome.value;
      const finalStatus = normalizeAgentRunStatus(r);
      if (finalStatus === 'succeeded') {
        finish(t.id, 'success', 0, r.output.slice(0, 4000), '', finalStatus);
      } else if (finalStatus === 'cancelled') {
        finish(t.id, 'cancelled', null, r.output.slice(0, 4000), '用户取消', finalStatus);
      } else {
        const error = r.output.slice(0, 300) || `子代理以 ${finalStatus} 结束`;
        finish(t.id, 'failed', 1, r.output.slice(0, 4000), error, finalStatus);
      }
    } finally {
      clearTimeout(timeout);
      timers.delete(t.id);
      agentAborts.delete(t.id);
    }
  }

  // ── 完成收口：状态/事件/通知 + 父任务聚合 ──
  function finish(
    id: string,
    status: TaskStatus,
    exitCode: number | null,
    output: string,
    error: string,
    runStatus?: RunFinalStatus,
  ): void {
    const t = row(id);
    if (!t || t.status === 'success' || t.status === 'failed' || t.status === 'cancelled') return;
    setStatus(id, status, { done_at: Date.now(), exit_code: exitCode, output: (output ?? '').slice(0, 4000), error: (error ?? '').slice(0, 300) });
    const emitComplete = () => bus.emit('jobs.complete', {
      id,
      kind: t.kind,
      status,
      exit_code: exitCode,
      parent_id: t.parent_id,
      duration_ms: Date.now() - t.created_at,
      output: (output ?? '').slice(0, 4000),
      error: (error ?? '').slice(0, 300),
    });
    const lifecycle = taskRuns.get(id);
    if (lifecycle) bus.withinRun(lifecycle.context, emitComplete);
    else emitComplete();
    if (t.parent_id) maybeSettleParent(t.parent_id);
    const dur = ((Date.now() - t.created_at) / 1000).toFixed(1);
    const emitNotice = () => bus.emit('system.notice', {
      text: `后台任务 ${id} ${status === 'success' ? '✅ 完成' : status === 'failed' ? '❌ 失败' : '⏹ 已取消'}（${dur}s）——/jobs show ${id} 查看${t.log_file ? ` ｜ 日志 ${t.log_file}` : ''}`,
    });
    if (lifecycle) bus.withinRun(lifecycle.context, emitNotice);
    else emitNotice();
    finalizeTaskRun(id, runStatus ?? (status === 'success' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed'), error);
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

  async function cancelLeaf(id: string, reason: string): Promise<void> {
    const task = row(id);
    if (!task || task.status === 'success' || task.status === 'failed' || task.status === 'cancelled') return;
    const queueIndex = queue.indexOf(id);
    if (queueIndex >= 0) queue.splice(queueIndex, 1);
    pausedIds.delete(id);

    if (task.status === 'queued') {
      finish(id, 'cancelled', null, task.output, reason, 'cancelled');
      return;
    }
    if (task.kind === 'agent') {
      agentAborts.get(id)?.abort(reason);
      finish(id, 'cancelled', null, task.output, reason, 'cancelled');
    } else if (task.kind === 'shell') {
      shellCancellationReasons.set(id, reason);
      const controller = shellAborts.get(id);
      controller?.abort(reason);
      const execution = activeShells.get(id);
      if (execution) void beginShellTermination(execution, 'cancel');
      else if (!controller) finish(id, 'failed', 125, task.output, '进程树终止失败：运行中 shell 缺少进程所有权', 'failed');
    }
    const active = activeTasks.get(id);
    if (active) await active;
  }

  async function killTask(id: string, reason = '用户取消'): Promise<boolean> {
    const task = row(id);
    if (!task) return false;
    if (task.kind === 'parallel') {
      for (const child of childrenOf(id)) {
        if (child.status === 'queued' || child.status === 'running') await killTask(child.id, reason);
      }
      const current = row(id);
      if (current?.status === 'queued' || current?.status === 'running') {
        maybeSettleParent(id);
        const unsettled = row(id);
        if (unsettled?.status === 'queued' || unsettled?.status === 'running') {
          finish(id, 'cancelled', null, unsettled.output, reason, 'cancelled');
        }
      }
    } else {
      await cancelLeaf(id, reason);
    }
    return true;
  }

  async function drainOwnedTasks(reason: string): Promise<void> {
    queue.length = 0;
    pausedIds.clear();
    const owned = [...taskRuns.keys()];
    const leaves = owned.filter(id => row(id)?.kind !== 'parallel');
    await Promise.all(leaves.map(id => cancelLeaf(id, reason)));
    await Promise.allSettled([...activeTasks.values()]);
    for (const id of owned) {
      const task = row(id);
      if (!task || task.kind !== 'parallel' || (task.status !== 'queued' && task.status !== 'running')) continue;
      maybeSettleParent(id);
      const unsettled = row(id);
      if (unsettled?.status === 'queued' || unsettled?.status === 'running') {
        finish(id, 'cancelled', null, unsettled.output, reason, 'cancelled');
      }
    }
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    run(spec, parentId = '') {
      assertAccepting();
      const id = create(spec, parentId);
      queue.push(id);
      pump();
      return id;
    },

    runParallel(main, branches) {
      assertAccepting();
      // 父任务（编排器，kind=parallel 不占执行槽）→ 全部子任务入队并行
      const parentId = create({ ...main, kind: 'parallel', goal: `并行任务：${main.goal.slice(0, 60)}${branches.length ? ` ＋ ${branches.length} 条支线` : ''}` }, '');
      const children = [...(main.kind === 'shell' || main.kind === 'agent' ? [main] : []), ...branches].map(b => create(b, parentId));
      for (const c of children) queue.push(c);
      pump();
      return { id: parentId, children };
    },

    kill: killTask,

    retry(id) {
      assertAccepting();
      const t = row(id);
      if (!t || t.status === 'running' || t.status === 'queued') return null;
      setStatus(id, 'queued', { pid: null, exit_code: null, error: '', done_at: null, started_at: null, output: '' });
      createTaskRun(id, t.parent_id);
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
      assertAccepting();
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
      const error = 'orphaned（进程退出遗留，可 /jobs retry）';
      for (const id of [...taskRuns.keys()]) finalizeTaskRun(id, 'failed', error);
      const n = db.prepare(`UPDATE tasks SET status='failed', error=?, done_at=? WHERE status IN ('queued','running')`).run(error, Date.now()).changes ?? 0;
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

    shutdown(reason) {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      shutdownPromise = drainOwnedTasks(reason || 'TaskRunner shutdown');
      return shutdownPromise;
    },

    // A25：并发上限读取（delegation.status caps 真实数据源——此前 UI 硬编码 4）
    getMaxConcurrent(): number {
      return maxConcurrent;
    },
  };
}
