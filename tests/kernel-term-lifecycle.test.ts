// tests/kernel-term-lifecycle.test.ts — 后台 PTY 所有权：物理退出确认、失败保持与关闭封禁
import { describe, expect, it, vi } from 'vitest';
import { createTerminalManager, type TerminalPtyLike } from '../src/kernel/term.js';

function createPty() {
  let exitHandler: (event: { exitCode: number }) => void = () => undefined;
  const pty: TerminalPtyLike = {
    pid: 77,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((handler: (event: { exitCode: number }) => void) => { exitHandler = handler; }),
  };
  return { pty, exit: (exitCode = 130) => exitHandler({ exitCode }) };
}

const createManager = (
  pty: TerminalPtyLike,
  terminateTree: (processId: number, deadlineMs: number) => Promise<{ ok: true } | { ok: false; error: string }>,
) => createTerminalManager({
  dataDir: process.cwd(),
  cwd: process.cwd(),
  loadPty: async () => ({ spawn: () => pty }),
  terminateTree,
  terminationDeadlineMs: 100,
});

describe('TerminalManager lifecycle', () => {
  it('kill waits for the PTY exit event before reporting success', async () => {
    const fake = createPty();
    const terminateTree = vi.fn(async () => ({ ok: true as const }));
    const manager = createManager(fake.pty, terminateTree);
    const opened = await manager.spawn('powershell.exe');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    let settled = false;
    const killing = manager.kill(opened.id).then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.get(opened.id)?.status).toBe('running');

    fake.exit();
    await expect(killing).resolves.toEqual({ ok: true });
    expect(manager.get(opened.id)?.status).toBe('exited');
    expect(terminateTree).toHaveBeenCalledWith(77, 100);
  });

  it('keeps the session running when process-tree termination is not confirmed', async () => {
    const fake = createPty();
    const manager = createManager(fake.pty, async () => ({ ok: false, error: 'tree still running' }));
    const opened = await manager.spawn('powershell.exe');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await expect(manager.kill(opened.id)).resolves.toEqual({ ok: false, error: 'tree still running' });
    expect(manager.get(opened.id)?.status).toBe('running');
  });

  it('shutdown closes admission immediately, drains sessions, and is idempotent', async () => {
    const fake = createPty();
    const manager = createManager(fake.pty, async () => ({ ok: true }));
    const opened = await manager.spawn('powershell.exe');
    expect(opened.ok).toBe(true);

    const first = manager.shutdown('test');
    const second = manager.shutdown('duplicate');
    expect(second).toBe(first);
    await expect(manager.spawn('powershell.exe')).resolves.toMatchObject({ ok: false, error: '终端管理器已关闭' });
    fake.exit();
    await expect(first).resolves.toBeUndefined();
  });
});
