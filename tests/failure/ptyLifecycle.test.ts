// tests/failure/ptyLifecycle.test.ts — W3-09：PTY 失败生命周期（平台/生成/超时/退出后写入/树终止失败）
import { describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter, type PtyLike } from '../../src/infrastructure/pty/nodePtyAdapter.js';

const makePty = (): PtyLike => {
  let exitHandler: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  return {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => exitHandler({ exitCode: 130 })),
    onData: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn((handler: (event: { exitCode: number; signal?: number }) => void) => { exitHandler = handler; return { dispose() {} }; }),
  };
};

const request = { executable: 'powershell.exe', argv: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24 };

describe('pty lifecycle failures', () => {
  it('fails closed on unsupported platforms', async () => {
    const adapter = new NodePtyAdapter({ platform: 'aix', spawn: vi.fn(), terminateTree: vi.fn() });
    await expect(adapter.open({ ...request, timeoutMs: 100 }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
      ok: false,
      error: { code: 'PTY_UNSUPPORTED_PLATFORM' },
    });
  });

  it('maps spawn failures to PTY_SPAWN_FAILED', async () => {
    const adapter = new NodePtyAdapter({
      platform: 'win32',
      spawn: vi.fn(() => { throw new Error('EINVAL'); }),
      terminateTree: vi.fn(),
    });
    await expect(adapter.open({ ...request, timeoutMs: 100 }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
      ok: false,
      error: { code: 'PTY_SPAWN_FAILED' },
    });
  });

  it('rejects stdin after exit with PTY_STDIN_AFTER_EXIT', async () => {
    const pty = makePty();
    const adapter = new NodePtyAdapter({ platform: 'win32', spawn: () => pty, terminateTree: vi.fn(async () => ({ ok: true as const, value: undefined })) });
    const opened = await adapter.open({ ...request, timeoutMs: 5_000 }, AbortSignal.timeout(1_000));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    pty.kill();
    await opened.value.wait();
    expect(() => opened.value.write('dir')).toThrowError('PTY_STDIN_AFTER_EXIT');
  });

  it('resolves timeout with reason timeout and closes cleanly', async () => {
    const pty = makePty();
    const adapter = new NodePtyAdapter({ platform: 'win32', spawn: () => pty, terminateTree: vi.fn(async () => ({ ok: true as const, value: undefined })) });
    const opened = await adapter.open({ ...request, timeoutMs: 20 }, AbortSignal.timeout(1_000));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(opened.value.wait()).resolves.toMatchObject({ reason: 'timeout', exitCode: null });
  });

  it('reports PTY_PROCESS_TREE_STILL_RUNNING when termination fails on close', async () => {
    const pty = makePty();
    const adapter = new NodePtyAdapter({
      platform: 'win32',
      spawn: () => pty,
      terminateTree: vi.fn(async () => ({ ok: false as const, error: { code: 'PTY_PROCESS_TREE_STILL_RUNNING', message: 'x', messageKey: 'x', retryable: false } })),
    });
    const opened = await adapter.open({ ...request, timeoutMs: 5_000 }, AbortSignal.timeout(1_000));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(opened.value.close()).resolves.toMatchObject({ ok: false, error: { code: 'PTY_PROCESS_TREE_STILL_RUNNING' } });
  });
});
