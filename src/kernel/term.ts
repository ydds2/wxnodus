// src/kernel/term.ts — 后台终端：node-pty 真实交互会话
// 与 /jobs（一次性后台执行、无 stdin）不同：/term 提供持久 PTY——
// python REPL / ssh / 任何交互式命令都能跑，可注入输入、跟随输出。
// node-pty 是 CJS 原生模块——动态 import（ESM 兼容）；生命周期随 CLI。
import { join } from 'node:path';
import { sanitizedEnv } from './env.js';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { terminateProcessTree, type ProcessTreeTerminationResult } from '../infrastructure/process/processSupervisor.js';

export interface TerminalPtyLike {
  pid: number;
  write(input: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (chunk: string) => void): unknown;
  onExit(handler: (event: { exitCode: number }) => void): unknown;
}

interface TerminalPtyModule {
  spawn(shell: string, args: string[], options: Record<string, unknown>): TerminalPtyLike;
}

export interface TermSession {
  id: string;
  shell: string;
  cwd: string;
  startedAt: number;
  status: 'running' | 'exited';
  exitCode: number | null;
  /** 输出缓冲（cap 4000 字符——attach 时尾部跟随） */
  buffer: string;
  /** node-pty 实例（类型经动态 import 解析） */
  pty: unknown;
}

export interface TermManager {
  spawn(shell?: string, cwd?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  write(id: string, input: string): { ok: true } | { ok: false; error: string };
  kill(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** A24 第四类修复：调整 PTY 尺寸（node-pty resize 真实转发——此前 UI 发的 resize 是空 stub） */
  resize(id: string, cols: number, rows: number): { ok: true } | { ok: false; error: string };
  list(): TermSession[];
  get(id: string): TermSession | null;
  getLog(id: string): string;
  /** 同步封禁新会话，等待所有持有的 PTY 物理退出；失败时拒绝伪造已关闭。 */
  shutdown(reason: string): Promise<void>;
}

export interface TerminalManagerOptions {
  dataDir: string;
  cwd: string;
  loadPty?: () => Promise<TerminalPtyModule>;
  terminateTree?: (processId: number, deadlineMs: number) => Promise<ProcessTreeTerminationResult>;
  terminationDeadlineMs?: number;
}

interface OwnedTermSession extends TermSession {
  pty: TerminalPtyLike;
  exitPromise: Promise<void>;
  resolveExit(): void;
  killPromise?: Promise<{ ok: true } | { ok: false; error: string }>;
}

const BUFFER_CAP = 4000;
const DEFAULT_TERMINATION_DEADLINE_MS = 5_000;

export function createTerminalManager(opts: TerminalManagerOptions): TermManager {
  const sessions = new Map<string, OwnedTermSession>();
  let ptyReady: Promise<TerminalPtyModule> | null = null;
  let admissionClosed = false;
  let shutdownPromise: Promise<void> | undefined;
  const terminationDeadlineMs = opts.terminationDeadlineMs ?? DEFAULT_TERMINATION_DEADLINE_MS;
  const terminateTree = opts.terminateTree ?? terminateProcessTree;

  const loadPty = (): Promise<TerminalPtyModule> => {
    ptyReady ??= opts.loadPty?.() ?? import('node-pty') as Promise<unknown> as Promise<TerminalPtyModule>;
    return ptyReady;
  };

  const appendBuffer = (session: TermSession, chunk: string): void => {
    session.buffer = (session.buffer + chunk).slice(-BUFFER_CAP);
  };

  const waitForExit = async (session: OwnedTermSession): Promise<boolean> => {
    if (session.status === 'exited') return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), terminationDeadlineMs);
      timer.unref?.();
    });
    const exited = await Promise.race([session.exitPromise.then(() => true as const), timeout]);
    if (timer) clearTimeout(timer);
    return exited;
  };

  const manager: TermManager = {
    async spawn(shell?: string, cwd?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
      if (admissionClosed) return { ok: false, error: '终端管理器已关闭' };
      try {
        const ptyMod = await loadPty();
        if (admissionClosed) return { ok: false, error: '终端管理器已关闭' };
        const shellName = shell?.trim() || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
        const sessionCwd = cwd?.trim() || opts.cwd;
        try { mkdirSync(join(opts.dataDir, 'term'), { recursive: true }); } catch { /* 忽略 */ }
        const proc = ptyMod.spawn(shellName, [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: sessionCwd,
          // B-15（V4 P4-7）：pty 会话环境走 sanitizedEnv——密钥/令牌类变量不进子 shell
          //（此前整包 process.env 透传：fs_read 环境可见面扩到任意 shell 内 echo $KEY）
          env: sanitizedEnv(),
        });
        const id = `t${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
        let resolveExit!: () => void;
        const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
        const session: OwnedTermSession = {
          id,
          shell: shellName,
          cwd: sessionCwd,
          startedAt: Date.now(),
          status: 'running',
          exitCode: null,
          buffer: '',
          pty: proc,
          exitPromise,
          resolveExit,
        };
        proc.onData((chunk: string) => appendBuffer(session, chunk));
        proc.onExit(({ exitCode }: { exitCode: number }) => {
          if (session.status === 'exited') return;
          session.status = 'exited';
          session.exitCode = exitCode;
          appendBuffer(session, `\r\n[进程退出 code=${exitCode}]\r\n`);
          session.resolveExit();
        });
        sessions.set(id, session);
        return { ok: true, id };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const hint = /node-pty|Cannot find module|NODE_MODULE_VERSION|was compiled against/i.test(msg)
          ? '（node-pty 原生模块缺失/不匹配——运行 npm install node-pty 或重装依赖后重试）'
          : '';
        return { ok: false, error: `终端启动失败：${msg.slice(0, 120)}${hint}` };
      }
    },

    write(id: string, input: string): { ok: true } | { ok: false; error: string } {
      const session = sessions.get(id);
      if (!session) return { ok: false, error: `终端 ${id} 不存在（/term 查看列表）` };
      if (session.status !== 'running') return { ok: false, error: `终端 ${id} 已退出（code=${session.exitCode ?? '?'}）` };
      try {
        session.pty.write(String(input ?? ''));
        appendBuffer(session, String(input ?? ''));
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: `输入失败：${String(e?.message ?? e).slice(0, 120)}` };
      }
    },

    kill(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const session = sessions.get(id);
      if (!session) return Promise.resolve({ ok: false, error: `终端 ${id} 不存在（/term 查看列表）` });
      if (session.status === 'exited') return Promise.resolve({ ok: true });
      if (session.killPromise) return session.killPromise;
      session.killPromise = (async () => {
        const stopped = await terminateTree(session.pty.pid, terminationDeadlineMs);
        if (!stopped.ok) return { ok: false, error: stopped.error };
        try { session.pty.kill(); } catch { /* taskkill 已终止进程树 */ }
        if (!await waitForExit(session)) {
          return { ok: false, error: `终端 ${id} 未在 ${terminationDeadlineMs}ms 内确认物理退出` };
        }
        return { ok: true };
      })();
      return session.killPromise;
    },

    resize(id: string, cols: number, rows: number): { ok: true } | { ok: false; error: string } {
      const session = sessions.get(id);
      if (!session) return { ok: false, error: `终端 ${id} 不存在（/term 查看列表）` };
      if (session.status !== 'running') return { ok: false, error: `终端 ${id} 已退出（code=${session.exitCode ?? '?'}）` };
      const width = Math.max(1, Math.floor(Number(cols) || 100));
      const height = Math.max(1, Math.floor(Number(rows) || 30));
      try {
        session.pty.resize(width, height);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: `调整尺寸失败：${String(e?.message ?? e).slice(0, 120)}` };
      }
    },

    list(): TermSession[] {
      return [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
    },

    get(id: string): TermSession | null {
      return sessions.get(id) ?? null;
    },

    getLog(id: string): string {
      return sessions.get(id)?.buffer ?? '';
    },

    shutdown(_reason: string): Promise<void> {
      admissionClosed = true;
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          const running = [...sessions.values()].filter(session => session.status === 'running');
          const results = await Promise.all(running.map(session => manager.kill(session.id)));
          const failures = results
            .map((result, index) => result.ok ? null : `${running[index]?.id}:${result.error}`)
            .filter((value): value is string => value !== null);
          if (failures.length) throw new Error(`TERMINAL_SHUTDOWN_INCOMPLETE:${failures.join(',')}`);
        })();
      }
      return shutdownPromise;
    },
  };

  return manager;
}
