// tests/cli-lifecycle.test.ts — CLI 宿主形态与组合根关闭顺序
import { describe, expect, it, vi } from 'vitest';
import { createCliShutdown, isLiveDelegateHost } from '../src/cli/lifecycle.js';

describe('CLI execution lifecycle', () => {
  it('only persistent serve and TTY TUI hosts may own live delegates', () => {
    expect(isLiveDelegateHost({ serve: true, prompt: null, stdinIsTTY: false })).toBe(true);
    expect(isLiveDelegateHost({ serve: false, prompt: null, stdinIsTTY: true })).toBe(true);
    expect(isLiveDelegateHost({ serve: false, prompt: 'inspect', stdinIsTTY: true })).toBe(false);
    expect(isLiveDelegateHost({ serve: false, prompt: null, stdinIsTTY: false })).toBe(false);
    expect(isLiveDelegateHost({ serve: false, prompt: '/delegate inspect', stdinIsTTY: false })).toBe(false);
  });

  it('stops CLI ingress and workers before composition dependencies', async () => {
    const order: string[] = [];
    const composition = vi.fn(async () => { order.push('composition'); return [] as string[]; });
    const shutdown = createCliShutdown(composition, [
      { id: 'task-runner', dispose: async () => { order.push('task-runner'); } },
      { id: 'a2a-server', dispose: async () => { order.push('a2a-server'); } },
      { id: 'serve', dispose: async () => { order.push('serve'); } },
    ]);

    await expect(shutdown('test')).resolves.toEqual([]);
    expect(order).toEqual(['serve', 'a2a-server', 'task-runner', 'composition']);
    expect(composition).toHaveBeenCalledWith('test');
  });

  it('reports composition failures through the unified failure list', async () => {
    const shutdown = createCliShutdown(async () => ['run-coordinator'], []);
    await expect(shutdown('test')).resolves.toEqual(['composition']);
  });
});
