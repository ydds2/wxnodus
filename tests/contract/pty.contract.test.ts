// tests/contract/pty.contract.test.ts — W3-09 Step 1：node-pty 契约（计划原文）
import { describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter } from '../../src/infrastructure/pty/nodePtyAdapter.js';
import { defaultShellFor } from '../../src/infrastructure/pty/platformShell.js';

class FakePty {
  pid = 77;
  writes: string[] = [];
  sizes: Array<[number, number]> = [];
  dataHandler: (data: string) => void = () => undefined;
  exitHandler: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.exitHandler({ exitCode: 130 }); }
  onData(handler: (data: string) => void) { this.dataHandler = handler; return { dispose() {} }; }
  onExit(handler: (event: { exitCode: number; signal?: number }) => void) { this.exitHandler = handler; return { dispose() {} }; }
}

describe.each([
  ['win32', 'powershell.exe'],
  ['linux', '/bin/bash'],
  ['darwin', '/bin/zsh'],
] as const)('%s node-pty contract', (platform, expectedShell) => {
  it('supports stdin, output, resize, exit, timeout/abort tree termination, and platform shell selection', async () => {
    expect(defaultShellFor(platform, {})).toBe(expectedShell);
    const fake = new FakePty();
    const spawn = vi.fn(() => fake);
    const terminateTree = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const adapter = new NodePtyAdapter({ spawn, terminateTree, platform });
    const controller = new AbortController();
    const opened = await adapter.open({ executable: expectedShell, argv: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, timeoutMs: 10_000 }, controller.signal);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const output: string[] = [];
    opened.value.onData(data => output.push(data));
    opened.value.write('dir\r');
    opened.value.resize(120, 40);
    fake.dataHandler('ready');
    fake.exitHandler({ exitCode: 0 });
    await expect(opened.value.wait()).resolves.toEqual({ exitCode: 0, signal: null, reason: 'exit' });
    expect(fake.writes).toEqual(['dir\r']);
    expect(fake.sizes).toEqual([[120, 40]]);
    expect(output).toEqual(['ready']);

    const second = await adapter.open({ executable: expectedShell, argv: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, timeoutMs: 10_000 }, controller.signal);
    expect(second.ok).toBe(true);
    controller.abort();
    await Promise.resolve();
    expect(terminateTree).toHaveBeenCalledWith(77, 5_000);
  });
});

it('rejects invalid resize values', async () => {
  const fake = new FakePty();
  const adapter = new NodePtyAdapter({ spawn: () => fake, terminateTree: vi.fn(), platform: 'win32' });
  const opened = await adapter.open({ executable: 'powershell.exe', argv: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, timeoutMs: 100 }, AbortSignal.timeout(1_000));
  expect(opened.ok).toBe(true);
  if (opened.ok) expect(() => opened.value.resize(0, 24)).toThrowError('PTY_INVALID_SIZE');
});
