// tests/wave2/w2-shutdown.test.ts — W2-03：统一幂等关闭——全部 disposer 尝试、聚合失败、严格逆序
import { describe, expect, it } from 'vitest';
import { createShutdown } from '../../src/bootstrap/bootstrapShutdown.js';
import type { BootstrapResource } from '../../src/bootstrap/bootstrapTypes.js';

describe('unified shutdown', () => {
  it('disposes every resource in strict reverse order', async () => {
    const order: string[] = [];
    const resources: BootstrapResource[] = [
      { id: 'a', dispose: async () => { order.push('a'); } },
      { id: 'b', dispose: async () => { order.push('b'); } },
      { id: 'c', dispose: async () => { order.push('c'); } },
    ];
    const failures = await createShutdown(resources)('test');
    expect(order).toEqual(['c', 'b', 'a']);
    expect(failures).toEqual([]);
  });

  it('keeps disposing after a failing resource and aggregates its id', async () => {
    const order: string[] = [];
    const resources: BootstrapResource[] = [
      { id: 'a', dispose: async () => { order.push('a'); } },
      { id: 'broken', dispose: async () => { throw new Error('boom'); } },
      { id: 'c', dispose: async () => { order.push('c'); } },
    ];
    const failures = await createShutdown(resources)('test');
    expect(order).toEqual(['c', 'a']);
    expect(failures).toEqual(['broken']);
  });

  it('treats a rejected dispose promise the same as a thrown one', async () => {
    const resources: BootstrapResource[] = [
      { id: 'rejected', dispose: async () => { throw new Error('async boom'); } },
    ];
    const failures = await createShutdown(resources)('test');
    expect(failures).toEqual(['rejected']);
  });

  it('is idempotent: a second call reuses the same settled result', async () => {
    let calls = 0;
    const resources: BootstrapResource[] = [
      { id: 'once', dispose: async () => { calls += 1; } },
    ];
    const shutdown = createShutdown(resources);
    const first = await shutdown('a');
    const second = await shutdown('b');
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });
});
