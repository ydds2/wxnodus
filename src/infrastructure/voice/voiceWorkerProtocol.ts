// src/infrastructure/voice/voiceWorkerProtocol.ts — 语音 worker 进程协议：executable + argv（无 shell 拼接），
// AbortSignal 取消 + Windows 进程树终止（taskkill /T /F）确认退出
import { spawn, execFile } from 'node:child_process';
import type { OperationResult } from '../../protocol/results.js';

export interface VoiceWorkerResult {
  processId: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface VoiceWorkerSpawnOptions { timeoutMs: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv }

export function spawnVoiceWorker(
  executable: string,
  args: string[],
  options: VoiceWorkerSpawnOptions,
  signal: AbortSignal,
): Promise<VoiceWorkerResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env });
    const cap = options.maxBufferBytes ?? 1024 * 1024;
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-cap); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-cap); });

    const finish = (result: VoiceWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    const onAbort = () => { aborted = true; child.kill(); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('exit', (code, sig) => {
      if (aborted) finish({ processId: child.pid ?? -1, exitCode: code, signal: sig, stdout, stderr, timedOut: false, aborted: true });
      else finish({ processId: child.pid ?? -1, exitCode: code, signal: sig, stdout, stderr, timedOut, aborted: false });
    });
  });
}

export function terminateVoiceWorkerTree(processId: number, deadlineMs = 5_000): Promise<OperationResult<void>> {
  return new Promise(resolve => {
    if (!Number.isInteger(processId) || processId <= 0) {
      resolve({ ok: true, value: undefined });
      return;
    }
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { windowsHide: true, timeout: deadlineMs }, error => {
        resolve(error
          ? { ok: false, error: { code: 'VOICE_PROCESS_TREE_STILL_RUNNING', message: String(error.message), messageKey: 'VOICE_PROCESS_TREE_STILL_RUNNING', retryable: false } }
          : { ok: true, value: undefined });
      });
      return;
    }
    try { process.kill(-processId, 'SIGKILL'); resolve({ ok: true, value: undefined }); }
    catch { resolve({ ok: false, error: { code: 'VOICE_PROCESS_TREE_STILL_RUNNING', message: 'kill failed', messageKey: 'VOICE_PROCESS_TREE_STILL_RUNNING', retryable: false } }); }
  });
}
