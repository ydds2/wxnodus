// src/infrastructure/pty/nodePtyAdapter.ts — node-pty 生命周期适配：超时/取消/退出三态 + 进程树终止确认
import type { OperationResult } from '../../protocol/results.js';
import type { PtyExit, PtyOpenRequest, PtyPort, PtySessionPort } from '../../domain/pty/pty.js';

export interface PtyLike {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface NodePtyPorts {
  platform: NodeJS.Platform;
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyLike;
  terminateTree(processId: number, deadlineMs: number): Promise<OperationResult<void>>;
}

const fail = <T = never>(code: string): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

const invalidSize = (cols: number, rows: number) =>
  !Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1;

export class NodePtyAdapter implements PtyPort {
  constructor(private readonly ports: NodePtyPorts) {}

  async open(request: PtyOpenRequest, signal: AbortSignal): Promise<OperationResult<PtySessionPort>> {
    if (!['win32', 'linux', 'darwin'].includes(this.ports.platform)) return fail('PTY_UNSUPPORTED_PLATFORM');
    if (invalidSize(request.cols, request.rows)) return fail('PTY_INVALID_SIZE');
    let pty: PtyLike;
    try {
      pty = this.ports.spawn(request.executable, request.argv, {
        name: 'xterm-256color', cols: request.cols, rows: request.rows, cwd: request.cwd, env: request.env,
      });
    } catch {
      return fail('PTY_SPAWN_FAILED');
    }

    let exit: PtyExit | null = null;
    const exitWaiters = new Set<(value: PtyExit) => void>();
    const dataHandlers = new Set<(data: string) => void>();
    const settle = (value: PtyExit) => {
      if (exit) return;
      exit = value;
      for (const waiter of exitWaiters) waiter(value);
      exitWaiters.clear();
    };

    const dataDisposable = pty.onData(data => { for (const handler of [...dataHandlers]) handler(data); });
    const exitDisposable = pty.onExit(event => settle({ exitCode: event.exitCode, signal: event.signal ?? null, reason: 'exit' }));
    const timer = setTimeout(() => {
      settle({ exitCode: null, signal: null, reason: 'timeout' });
      try { pty.kill(); } catch { /* 超时即终态；kill 触发的 exit 事件被 settle 忽略 */ }
    }, request.timeoutMs);
    timer.unref?.();

    const terminateTree = this.ports.terminateTree;
    const onAbort = () => {
      if (exit) return;
      void terminateTree(pty.pid, 5_000).then(stopped => {
        try { pty.kill(); } catch { /* 树终止即终态 */ }
        void stopped;
        settle({ exitCode: null, signal: null, reason: 'abort' });
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const session: PtySessionPort = {
      processId: pty.pid,
      write(data) {
        if (exit) throw Object.assign(new Error('PTY_STDIN_AFTER_EXIT'), { code: 'PTY_STDIN_AFTER_EXIT' });
        pty.write(data);
      },
      resize(cols, rows) {
        if (invalidSize(cols, rows)) throw Object.assign(new Error('PTY_INVALID_SIZE'), { code: 'PTY_INVALID_SIZE' });
        pty.resize(cols, rows);
      },
      onData(handler) {
        dataHandlers.add(handler);
        return () => { dataHandlers.delete(handler); };
      },
      wait() {
        return exit ? Promise.resolve(exit) : new Promise<PtyExit>(resolve => exitWaiters.add(resolve));
      },
      async close() {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (!exit) {
          const stopped = await terminateTree(pty.pid, 5_000);
          if (!stopped.ok) return stopped;
          try { pty.kill(); } catch { /* 树已终止 */ }
        }
        dataDisposable.dispose();
        exitDisposable.dispose();
        return { ok: true, value: undefined };
      },
    };
    return { ok: true, value: session };
  }
}
