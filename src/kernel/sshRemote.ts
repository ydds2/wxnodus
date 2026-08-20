// src/kernel/sshRemote.ts — 远程执行 ssh 通道（supremacy 2.2 / 缺陷 S-04 阶段 1 落地，2026-08-18）
// 机制参考：codex exec-server（远程执行、本地审批）——实现原创（ssh 转发先行，完整版留后续）。
// settings.remote = "ssh://user@host[:port]" → bash 工具与 /remote run 经本机 `ssh` 客户端转发执行：
//   - 本地审批链不变（命令先审批后执行——agent 权限门在前，本模块只负责通道）
//   - 输出流式回传、超时/断线/非零退出码诚实报错（绝不伪装成功）
// 诚实口径（红线）：阶段 1 远端**未沙盒**——远端命令以远端用户权限执行，任何输出/提示
// 必须携带 REMOTE_UNSANDBOXED_NOTE；完整版（长驻 exec-server + 远端沙盒复用）安全面对齐 codex 后
// 才可宣称「远程执行」，见 docs/ide-remote-share-roadmap-2026.md §2。
import { execFile, type ExecFileOptions } from 'node:child_process';

/** 诚实口径常量：远端未沙盒——所有远程执行输出必带（UI/日志/工具输出同源） */
export const REMOTE_UNSANDBOXED_NOTE = '远端未沙盒：命令以远端用户权限执行（ssh 通道阶段 1——完整沙盒版对齐 codex exec-server 后上线）';

export interface RemoteTarget {
  user: string;
  host: string;
  port: number;
}

/** 解析 "ssh://user@host[:port]"（缺省端口 22；非法/空返回 null——调用方回退本地执行） */
export function parseRemoteTarget(remote: string): RemoteTarget | null {
  const s = String(remote ?? '').trim();
  if (!s) return null;
  const m = s.match(/^ssh:\/\/([^@/]+)@([^:/]+)(?::(\d+))?$/);
  if (!m) return null;
  const port = Number(m[3] ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { user: m[1]!, host: m[2]!, port };
}

/** ssh 客户端参数（BatchMode=yes 防交互卡死；ConnectTimeout 快速失败；禁用伪终端） */
export function buildSshArgs(target: RemoteTarget, command: string): string[] {
  return [
    '-p', String(target.port),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-T',
    `${target.user}@${target.host}`,
    command,
  ];
}

export type RemoteRunner = (file: string, args: string[], opts: ExecFileOptions) => { on: (ev: string, cb: (d: unknown) => void) => unknown; kill: (sig?: string) => void } & { pid?: number };

/** 注入式 ssh 客户端（默认 execFile 'ssh'——测试注入 mock runner） */
export const sshClient: { file: string; runner?: RemoteRunner } = { file: 'ssh' };

/** 默认执行器（隔离 execFile 重载噪声——生产路径） */
function defaultSshRunner(file: string, args: string[], opts: ExecFileOptions): ReturnType<RemoteRunner> {
  return (execFile as (f: string, a: string[], o: ExecFileOptions) => ReturnType<RemoteRunner>)(file, args, opts);
}

export interface RemoteCommandResult {
  ok: boolean;
  /** 进程退出码（ok=false 且 code=null 表示未正常结束：超时/杀灭） */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 人类可读错误（通道失败/超时/断线） */
  error: string | null;
  /** 远端目标回显（输出提示用） */
  target: RemoteTarget | null;
  /** 恒为 true 的诚实标记——消费方据此附加未沙盒提示 */
  remoteUnsandboxed: boolean;
}

/** 执行远程命令（流式回传；timeoutMs 超时 kill；signal 外部中断） */
export function runRemoteCommand(
  target: RemoteTarget | null,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = {},
): Promise<RemoteCommandResult> {
  return new Promise((resolve) => {
    if (!target) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: '远程目标未配置（settings.remote = ssh://user@host[:port]）', target: null, remoteUnsandboxed: true });
      return;
    }
    const args = buildSshArgs(target, command);
    let child: ReturnType<RemoteRunner> | null = null;
    try {
      const run = sshClient.runner ?? defaultSshRunner;
      child = run(sshClient.file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    } catch (e: any) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: `ssh 启动失败：${String(e?.message ?? e).slice(0, 200)}`, target, remoteUnsandboxed: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: RemoteCommandResult) => { if (!done) { done = true; resolve(r); } };
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* 忽略 */ }
      finish({ ok: false, code: null, stdout, stderr, error: `远程命令超时（${timeoutMs}ms）已终止`, target, remoteUnsandboxed: true });
    }, timeoutMs);
    const onAbort = () => {
      try { child?.kill('SIGKILL'); } catch { /* 忽略 */ }
      finish({ ok: false, code: null, stdout, stderr, error: '远程命令已中断', target, remoteUnsandboxed: true });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child.on('error', (e: any) => {
        const msg = String(e?.message ?? e);
        const hint = /ENOENT/i.test(msg) ? '（未找到 ssh 客户端——Windows 需启用可选功能 OpenSSH Client）' : '';
        finish({ ok: false, code: null, stdout, stderr, error: `ssh 通道失败：${msg.slice(0, 200)}${hint}`, target, remoteUnsandboxed: true });
      });
      (child as any).stdout?.setEncoding?.('utf8');
      (child as any).stderr?.setEncoding?.('utf8');
      (child as any).stdout?.on?.('data', (c: Buffer | string) => { const t = String(c); stdout += t; opts.onStdout?.(t); });
      (child as any).stderr?.on?.('data', (c: Buffer | string) => { const t = String(c); stderr += t; opts.onStderr?.(t); });
      (child as any).on?.('close', (code: number | null) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        finish({ ok: code === 0, code, stdout, stderr, error: code === 0 ? null : `远端命令退出码 ${code}`, target, remoteUnsandboxed: true });
      });
    } catch (e: any) {
      finish({ ok: false, code: null, stdout, stderr, error: `ssh 通道异常：${String(e?.message ?? e).slice(0, 200)}`, target, remoteUnsandboxed: true });
    }
  });
}
