// src/infrastructure/autonomy/delegateManagerWiring.ts — 现代子代理的进程与 worktree 生产端口
import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  createDelegateManager,
  type DelegateProcessHandle,
} from '../../application/autonomy/delegateManager.js';
import type { EventBus } from '../../kernel/events.js';
import type { OperationResult } from '../../protocol/results.js';
import { WorktreeManager } from './worktreeManager.js';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 64 * 1024;

export interface DelegateSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function resolveDelegateSpawnSpec(input: {
  moduleUrl: string;
  goal: string;
  cwd: string;
  dataDir: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}): DelegateSpawnSpec {
  const modulePath = fileURLToPath(input.moduleUrl);
  const sourceRuntime = extname(modulePath).toLowerCase() === '.ts';
  const cliEntry = resolve(dirname(modulePath), '..', '..', 'cli', sourceRuntime ? 'index.ts' : 'index.js');
  const command = input.execPath ?? process.execPath;
  const args = sourceRuntime
    ? [resolve(dirname(modulePath), '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), cliEntry]
    : [cliEntry];
  args.push('-p', input.goal, '--workspace', input.cwd, '--session', input.sessionId);
  return {
    command,
    args,
    cwd: input.cwd,
    env: {
      ...(input.env ?? process.env),
      WXNODUS_WORKSPACE: input.cwd,
      WXNODUS_DATA_DIR: input.dataDir,
    },
  };
}

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export function createProductionDelegateManager(input: {
  bus: EventBus;
  dataDir: string;
  workspaceRoot: string;
}) {
  const worktrees = new WorktreeManager({
    dataDir: input.dataDir,
    git: async (args, options) => {
      try {
        const result = await execFileAsync('git', args, {
          cwd: options?.cwd ?? input.workspaceRoot,
          shell: false,
          windowsHide: true,
        });
        return { ok: true as const, value: { stdout: String(result.stdout), stderr: String(result.stderr) } };
      } catch (cause) {
        return fail('WORKTREE_GIT_FAILED', { message: String((cause as Error)?.message ?? cause) });
      }
    },
    realpath,
  });

  return createDelegateManager({
    bus: input.bus,
    worktrees,
    process: {
      start: async (goal, cwd, signal, sessionId): Promise<OperationResult<DelegateProcessHandle>> => {
        try {
          const spec = resolveDelegateSpawnSpec({
            moduleUrl: import.meta.url,
            goal,
            cwd,
            dataDir: input.dataDir,
            sessionId,
          });
          const child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (!child.pid) return fail('SUBAGENT_SPAWN_FAILED');
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-OUTPUT_LIMIT); });
          child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-OUTPUT_LIMIT); });

          const completion = new Promise<{
            exitCode: number | null;
            signal: string | null;
            stdout: string;
            stderr: string;
          }>((resolveCompletion, reject) => {
            child.once('error', reject);
            child.once('close', (exitCode, closeSignal) => {
              resolveCompletion({ exitCode, signal: closeSignal, stdout, stderr });
            });
          });
          const processId = child.pid;
          const terminate = async (deadlineMs: number): Promise<OperationResult<void>> => {
            if (child.exitCode !== null || child.signalCode !== null) return { ok: true, value: undefined };
            try {
              if (process.platform === 'win32') {
                await execFileAsync('taskkill', ['/pid', String(processId), '/t', '/f'], {
                  windowsHide: true,
                  timeout: deadlineMs,
                });
              } else {
                child.kill('SIGTERM');
              }
            } catch {
              if (child.exitCode === null && child.signalCode === null) {
                try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
              }
            }
            const exited = await Promise.race([
              completion.then(() => true, () => true),
              new Promise<boolean>(resolveWait => setTimeout(() => resolveWait(false), deadlineMs)),
            ]);
            return exited ? { ok: true, value: undefined } : fail('SUBAGENT_STOP_FAILED', { processId });
          };
          if (signal.aborted) void terminate(5_000);
          return { ok: true, value: { processId, completion, terminate } };
        } catch (cause) {
          return fail('SUBAGENT_SPAWN_FAILED', { message: String((cause as Error)?.message ?? cause) });
        }
      },
    },
    fence: async () => ({ ok: true, value: undefined }),
  });
}
