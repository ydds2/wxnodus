// src/kernel/term.ts — 后台终端：node-pty 真实交互会话
// 与 /jobs（一次性后台执行、无 stdin）不同：/term 提供持久 PTY——
// python REPL / ssh / 任何交互式命令都能跑，可注入输入、跟随输出。
// node-pty 是 CJS 原生模块——动态 import（ESM 兼容）；生命周期随 CLI
// （Windows detached 限制同 taskRunner：无独立进程孤儿化）。
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

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
  kill(id: string): { ok: true } | { ok: false; error: string };
  /** A24 第四类修复：调整 PTY 尺寸（node-pty resize 真实转发——此前 UI 发的 resize 是空 stub） */
  resize(id: string, cols: number, rows: number): { ok: true } | { ok: false; error: string };
  list(): TermSession[];
  get(id: string): TermSession | null;
  getLog(id: string): string;
}

const BUFFER_CAP = 4000;

export function createTerminalManager(opts: { dataDir: string; cwd: string }): TermManager {
  const sessions = new Map<string, TermSession>();
  let ptyReady: Promise<unknown> | null = null;

  const loadPty = (): Promise<unknown> => {
    ptyReady ??= import('node-pty') as Promise<unknown>;

    return ptyReady;
  };

  const appendBuffer = (s: TermSession, chunk: string): void => {
    s.buffer = (s.buffer + chunk).slice(-BUFFER_CAP);
  };

  return {
    async spawn(shell?: string, cwd?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
      try {
        const ptyMod = (await loadPty()) as any;
        const shellName = shell?.trim() || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
        const sessionCwd = cwd?.trim() || opts.cwd;
        // 终端会话目录（脚本类输出可选落盘；当前缓冲内存）
        try {
          mkdirSync(join(opts.dataDir, 'term'), { recursive: true });
        } catch { /* 忽略 */ }
        const proc = ptyMod.spawn(shellName, [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: sessionCwd,
          env: process.env,
        });
        const id = `t${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
        const session: TermSession = {
          id,
          shell: shellName,
          cwd: sessionCwd,
          startedAt: Date.now(),
          status: 'running',
          exitCode: null,
          buffer: '',
          pty: proc,
        };
        proc.onData((chunk: string) => appendBuffer(session, chunk));
        proc.onExit(({ exitCode }: { exitCode: number }) => {
          session.status = 'exited';
          session.exitCode = exitCode;
          appendBuffer(session, `\r\n[进程退出 code=${exitCode}]\r\n`);
        });
        sessions.set(id, session);

        return { ok: true, id };
      } catch (e: any) {
        // A25：node-pty 原生模块缺失时给安装指引（此前裸报模块加载错误）
        const msg = String(e?.message ?? e)
        const hint = /node-pty|Cannot find module|NODE_MODULE_VERSION|was compiled against/i.test(msg)
          ? '（node-pty 原生模块缺失/不匹配——运行 npm install node-pty 或重装依赖后重试）'
          : ''
        return { ok: false, error: `终端启动失败：${msg.slice(0, 120)}${hint}` };
      }
    },

    write(id: string, input: string): { ok: true } | { ok: false; error: string } {
      const s = sessions.get(id);

      if (!s) {
        return { ok: false, error: `终端 ${id} 不存在（/term 查看列表）` };
      }
      if (s.status !== 'running') {
        return { ok: false, error: `终端 ${id} 已退出（code=${s.exitCode ?? '?'}）` };
      }
      try {
        (s.pty as any).write(String(input ?? ''));
        appendBuffer(s, String(input ?? ''));

        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: `输入失败：${String(e?.message ?? e).slice(0, 120)}` };
      }
    },

    kill(id: string): { ok: true } | { ok: false; error: string } {
      const s = sessions.get(id);

      if (!s) {
        return { ok: false, error: `终端 ${id} 不存在（/term 查看列表）` };
      }
      try {
        (s.pty as any).kill();
        s.status = 'exited';
        s.exitCode = -1;
        appendBuffer(s, '\r\n[已终止]\r\n');

        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: `终止失败：${String(e?.message ?? e).slice(0, 120)}` };
      }
    },

    // A24 第四类修复：真实转发 node-pty resize（此前 gateway 侧是空 stub——UI 调整尺寸无效）
    resize(id: string, cols: number, rows: number): { ok: true } | { ok: false; error: string } {
      const s = sessions.get(id);

      if (!s) {
        return { ok: false, error: `终端 ${id} 不存在（/term 查看列表）` };
      }
      if (s.status !== 'running') {
        return { ok: false, error: `终端 ${id} 已退出（code=${s.exitCode ?? '?'}）` };
      }
      const w = Math.max(1, Math.floor(Number(cols) || 100));
      const h = Math.max(1, Math.floor(Number(rows) || 30));

      try {
        (s.pty as any).resize(w, h);

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
  };
}
