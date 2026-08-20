// src/infrastructure/process/processSupervisor.ts — 受监督子进程：process tree 终止 + generation fence（迟到结果丢弃）
// 静态 bypass 合同的唯一例外：只有本文件允许 import node:child_process（pipeline 的 execute 端口经此处派生进程）。
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { OperationResult } from '../../protocol/results.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';

export interface SupervisedProcessOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  signal: AbortSignal;
  collectChunks?: boolean;
}

export interface SupervisedProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killedBySignal: boolean;
  terminatedBySupervisor: boolean;
  durationMs: number;
}

export type ProcessTreeTerminationResult = { ok: true } | { ok: false; error: string };

/** 发出整棵进程树强制终止请求；调用方仍须等待所持进程的 exit/close 事件确认物理退出。 */
export function terminateProcessTree(
  processId: number,
  deadlineMs = 5_000,
): Promise<ProcessTreeTerminationResult> {
  if (!Number.isInteger(processId) || processId <= 0) {
    return Promise.resolve({ ok: false, error: 'PROCESS_TREE_INVALID_PID' });
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-processId, 'SIGKILL');
      return Promise.resolve({ ok: true });
    } catch {
      try {
        process.kill(processId, 'SIGKILL');
        return Promise.resolve({ ok: true });
      } catch (cause) {
        return Promise.resolve({ ok: false, error: `PROCESS_TREE_TERMINATION_FAILED:${String(cause)}` });
      }
    }
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (result: ProcessTreeTerminationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let killer: ChildProcess;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (cause) {
      resolve({ ok: false, error: `PROCESS_TREE_TERMINATION_FAILED:${String(cause)}` });
      return;
    }
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch { /* 截止时间已到 */ }
      finish({ ok: false, error: `PROCESS_TREE_TERMINATION_TIMEOUT:${deadlineMs}` });
    }, deadlineMs);
    timer.unref?.();
    killer.once('error', cause => finish({ ok: false, error: `PROCESS_TREE_TERMINATION_FAILED:${String(cause)}` }));
    killer.once('close', code => finish(code === 0
      ? { ok: true }
      : { ok: false, error: `PROCESS_TREE_TERMINATION_FAILED:taskkill exit ${code ?? 'null'}` }));
  });
}

/**
 * 启动并监督一个子进程：
 * - AbortSignal → Windows 上 taskkill /T /F 终止整棵进程树（先优雅后强杀）；
 * - generation fence：终止发生后迟到的 exit/输出不再作为结果返回（抛 OPERATION_CANCELLED）；
 * - timeoutMs 到期同样走终止路径。
 */
export async function runSupervisedProcess(options: SupervisedProcessOptions): Promise<OperationResult<SupervisedProcessOutcome>> {
  const startedAt = Date.now();
  let terminated = false;
  let child: ChildProcess | null = null;
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    return err(gatewayError('TOOL_EXECUTION_FAILED', 'process spawn 失败', 'tool.execution.failed', { retryable: false, details: { cause: String(cause) } }));
  }
  const proc = child;

  let stdout = '';
  let stderr = '';
  if (options.collectChunks !== false) {
    proc.stdout?.on('data', chunk => { stdout += String(chunk); });
    proc.stderr?.on('data', chunk => { stderr += String(chunk); });
  }

  const terminate = (): Promise<boolean> => new Promise(resolve => {
    if (proc.exitCode !== null || proc.killed) { resolve(false); return; }
    terminated = true;
    try {
      // Windows：taskkill /T 终止整棵树（node child.kill 只杀直接子进程）
      const pid = proc.pid;
      if (pid && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
        killer.on('exit', () => { resolve(true); });
        killer.on('error', () => {
          try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
          resolve(true);
        });
      } else {
        proc.kill('SIGTERM');
        const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2_000);
        proc.once('exit', () => { clearTimeout(force); resolve(true); });
        setTimeout(() => resolve(true), 2_500);
      }
    } catch {
      resolve(false);
    }
  });

  const timeoutHandle = setTimeout(() => { void terminate(); }, options.timeoutMs);
  const onAbort = () => { void terminate(); };
  if (options.signal.aborted) { clearTimeout(timeoutHandle); void terminate(); }
  else options.signal.addEventListener('abort', onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    if (proc.exitCode !== null) { resolve({ code: proc.exitCode, signal: null }); return; }
    proc.once('exit', (code, signal) => resolve({ code, signal }));
    proc.once('error', () => resolve({ code: null, signal: null }));
  });

  clearTimeout(timeoutHandle);
  options.signal.removeEventListener('abort', onAbort);

  // generation fence：被监督终止后迟到的结果一律按取消处理
  if (terminated || options.signal.aborted) {
    if (exit.code === null && !terminated) return err(gatewayError('PROCESS_TERMINATION_FAILED', 'process 终止失败', 'process.termination.failed'));
    return err(gatewayError('OPERATION_CANCELLED', 'Operation cancelled', 'operation.cancelled'));
  }
  return ok({
    exitCode: exit.code,
    stdout,
    stderr,
    killedBySignal: exit.signal !== null,
    terminatedBySupervisor: terminated,
    durationMs: Date.now() - startedAt,
  });
}
