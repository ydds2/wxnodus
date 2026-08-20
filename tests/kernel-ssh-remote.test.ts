// tests/kernel-ssh-remote.test.ts — supremacy 2.2 远程执行 ssh 通道（S-04 阶段 1）：解析/参数/执行契约（mock runner）
// 覆盖：目标解析（合法/非法/端口夹取）、ssh 参数构造（BatchMode/超时）、执行成功/非零退出码/
// 超时 kill/ENOENT 提示/外部中断、未沙盒诚实标记恒真、bash 工具远程分支（mock 通道）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseRemoteTarget, buildSshArgs, runRemoteCommand, REMOTE_UNSANDBOXED_NOTE, sshClient, type RemoteRunner } from '../src/kernel/sshRemote.js';

/** 最小 mock 子进程（EventEmitter 语义 + stdout/stderr 流 + close） */
function mockChild(script: (child: any) => void): ReturnType<RemoteRunner> {
  const listeners: Record<string, Array<(d: any) => void>> = {};
  const stream = () => {
    const sListeners: Record<string, Array<(d: any) => void>> = {};
    return {
      setEncoding: () => {},
      on: (ev: string, cb: (d: any) => void) => { (sListeners[ev] ??= []).push(cb); return stream; },
      emit: (ev: string, d: any) => (sListeners[ev] ?? []).forEach(cb => cb(d)),
    };
  };
  const child: any = {
    stdout: stream(),
    stderr: stream(),
    listeners,
    on: (ev: string, cb: (d: any) => void) => { (listeners[ev] ??= []).push(cb); return child; },
    emit: (ev: string, d: any) => (listeners[ev] ?? []).forEach(cb => cb(d)),
    // kill 不触发 close：真实进程 SIGKILL 后 close 异步到来——超时/中断分支的 finish 先赢
    kill: () => {},
  };
  queueMicrotask(() => script(child));
  return child;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('parseRemoteTarget（ssh:// 解析）', () => {
  it('合法目标：user@host 缺省端口 22；显式端口生效', () => {
    expect(parseRemoteTarget('ssh://dev@build-box')).toEqual({ user: 'dev', host: 'build-box', port: 22 });
    expect(parseRemoteTarget(' ssh://root@10.0.0.8:2222 ')).toEqual({ user: 'root', host: '10.0.0.8', port: 2222 });
  });
  it('非法/空：null（回退本地执行）', () => {
    expect(parseRemoteTarget('')).toBeNull();
    expect(parseRemoteTarget('build-box')).toBeNull();
    expect(parseRemoteTarget('ssh://host-only')).toBeNull();
    expect(parseRemoteTarget('ssh://u@h:99999')).toBeNull();
    expect(parseRemoteTarget(undefined as any)).toBeNull();
  });
});

describe('buildSshArgs（ssh 客户端参数）', () => {
  it('BatchMode 防交互 + ConnectTimeout + 无伪终端 + 目标与命令', () => {
    const args = buildSshArgs({ user: 'u', host: 'h', port: 2222 }, 'ls -la');
    expect(args).toEqual(['-p', '2222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', 'u@h', 'ls -la']);
  });
});

describe('runRemoteCommand（mock 执行契约）', () => {
  it('成功：stdout 流式回传、ok=true、未沙盒标记恒真', async () => {
    sshClient.runner = ((_f: string, _a: string[]) => mockChild(c => {
      c.stdout.emit('data', Buffer.from('hello\n'));
      c.emit('close', 0);
    })) as RemoteRunner;
    const r = await runRemoteCommand({ user: 'u', host: 'h', port: 22 }, 'echo hi');
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello\n');
    expect(r.remoteUnsandboxed).toBe(true);
    expect(r.error).toBeNull();
  });

  it('非零退出码：ok=false + 诚实报错（绝不伪装成功）', async () => {
    sshClient.runner = ((_f: string, _a: string[]) => mockChild(c => {
      c.stderr.emit('data', Buffer.from('permission denied'));
      c.emit('close', 1);
    })) as RemoteRunner;
    const r = await runRemoteCommand({ user: 'u', host: 'h', port: 22 }, 'bad');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('permission denied');
    expect(r.error).toContain('退出码 1');
  });

  it('ENOENT（无 ssh 客户端）→ 明确提示 Windows OpenSSH Client 指引', async () => {
    sshClient.runner = ((_f: string, _a: string[]) => mockChild(c => {
      c.emit('error', new Error('spawn ssh ENOENT'));
    })) as RemoteRunner;
    const r = await runRemoteCommand({ user: 'u', host: 'h', port: 22 }, 'ls');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOENT');
    expect(r.error).toContain('OpenSSH Client');
  });

  it('超时：kill + ok=false（60s 默认）', async () => {
    sshClient.runner = ((_f: string, _a: string[]) => mockChild(c => { /* 永不 close——超时触发 */ })) as RemoteRunner;
    const r = await runRemoteCommand({ user: 'u', host: 'h', port: 22 }, 'sleep 999', { timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
  });

  it('外部中断（abort）→ ok=false + 中断文案', async () => {
    sshClient.runner = ((_f: string, _a: string[]) => mockChild(c => { /* 挂起 */ })) as RemoteRunner;
    const ac = new AbortController();
    const p = runRemoteCommand({ user: 'u', host: 'h', port: 22 }, 'watch', { signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('中断');
  });

  it('未配置目标：直接失败 + 配置指引', async () => {
    const r = await runRemoteCommand(null, 'ls');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('settings.remote');
  });
});

describe('未沙盒诚实口径', () => {
  it('常量恒在：任何消费方必须附带（bash/远程命令输出同源）', () => {
    expect(REMOTE_UNSANDBOXED_NOTE).toContain('远端未沙盒');
  });
});
