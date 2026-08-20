import { describe, expect, it } from 'vitest';
import { reloadMcpRuntime } from '../src/application/tools/mcpRuntimeReload.js';
import type { McpClient } from '../src/kernel/mcp.js';

function client(name: string, events: string[], output = name): McpClient {
  let closed = false;
  return {
    server: { name, command: 'fixture' },
    connected: true,
    tools: [{ server: name, name: 'probe' }],
    async callTool() {
      if (closed) throw new Error(`${name}:closed`);
      return output;
    },
    close() { closed = true; events.push(`close:${name}`); },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('MCP runtime atomic reload', () => {
  it('同步失败时关闭候选，旧快照和旧客户端保持可用', async () => {
    const events: string[] = [];
    const oldClient = client('old', events, 'old-ok');
    const candidate = client('candidate', events);
    let published: McpClient[] = [oldClient];

    await expect(reloadMcpRuntime({
      current: published,
      connect: async () => { events.push('connect'); return [candidate]; },
      synchronize: () => { events.push('synchronize'); throw new Error('sync rejected'); },
      publish: clients => { events.push('publish'); published = clients; },
    })).rejects.toThrow('sync rejected');

    expect(events).toEqual(['connect', 'synchronize', 'close:candidate']);
    expect(published).toEqual([oldClient]);
    await expect(oldClient.callTool('probe', {})).resolves.toBe('old-ok');
    await expect(candidate.callTool('probe', {})).rejects.toThrow('candidate:closed');
  });

  it('拒绝未连接候选并保留旧客户端和工具快照', async () => {
    const events: string[] = [];
    const oldClient = client('old', events, 'old-ok');
    const disconnected = client('broken', events);
    disconnected.connected = false;
    let published: McpClient[] = [oldClient];

    await expect(reloadMcpRuntime({
      current: published,
      connect: async () => [disconnected],
      synchronize: () => events.push('synchronize'),
      publish: clients => { events.push('publish'); published = clients; },
    })).rejects.toMatchObject({ code: 'MCP_RUNTIME_CANDIDATE_DISCONNECTED', servers: ['broken'] });

    expect(events).toEqual(['close:broken']);
    expect(published).toEqual([oldClient]);
    await expect(oldClient.callTool('probe', {})).resolves.toBe('old-ok');
    await expect(disconnected.callTool('probe', {})).rejects.toThrow('broken:closed');
  });

  it('连接失败时旧快照和旧客户端保持可用', async () => {
    const events: string[] = [];
    const oldClient = client('old', events, 'old-ok');
    let published: McpClient[] = [oldClient];

    await expect(reloadMcpRuntime({
      current: published,
      connect: async () => { throw new Error('connect rejected'); },
      synchronize: () => events.push('synchronize'),
      publish: clients => { published = clients; },
    })).rejects.toThrow('connect rejected');

    expect(events).toEqual([]);
    expect(published).toEqual([oldClient]);
    await expect(oldClient.callTool('probe', {})).resolves.toBe('old-ok');
  });

  it('同步并发布候选后才关闭旧客户端', async () => {
    const events: string[] = [];
    const oldClient = client('old', events);
    const candidate = client('candidate', events, 'candidate-ok');
    let published: McpClient[] = [oldClient];

    const result = await reloadMcpRuntime({
      current: published,
      connect: async () => { events.push('connect'); return [candidate]; },
      synchronize: () => events.push('synchronize'),
      publish: clients => { events.push('publish'); published = clients; },
    });

    expect(events).toEqual(['connect', 'synchronize', 'publish', 'close:old']);
    expect(result).toEqual({ clients: [candidate], cleanupFailures: 0 });
    expect(published).toEqual([candidate]);
    await expect(candidate.callTool('probe', {})).resolves.toBe('candidate-ok');
    await expect(oldClient.callTool('probe', {})).rejects.toThrow('old:closed');
  });

  it('newer overlapping generation publishes first and stale candidate is closed', async () => {
    const events: string[] = [];
    const oldClient = client('old', events, 'old-ok');
    const staleCandidate = client('stale', events);
    const newestCandidate = client('newest', events, 'newest-ok');
    const firstConnected = deferred<McpClient[]>();
    const secondConnected = deferred<McpClient[]>();
    let published: McpClient[] = [oldClient];

    const first = reloadMcpRuntime({
      current: published,
      connect: () => firstConnected.promise,
      synchronize: clients => events.push(`sync:${clients[0]!.server.name}`),
      publish: clients => { events.push(`publish:${clients[0]!.server.name}`); published = clients; },
    });
    const second = reloadMcpRuntime({
      current: published,
      connect: () => secondConnected.promise,
      synchronize: clients => events.push(`sync:${clients[0]!.server.name}`),
      publish: clients => { events.push(`publish:${clients[0]!.server.name}`); published = clients; },
    });

    secondConnected.resolve([newestCandidate]);
    await second;
    firstConnected.resolve([staleCandidate]);
    const staleResult = await first;

    expect(events).toEqual([
      'sync:newest',
      'publish:newest',
      'close:old',
      'close:stale',
    ]);
    expect(staleResult).toEqual({ clients: [newestCandidate], cleanupFailures: 0, stale: true });
    expect(published).toEqual([newestCandidate]);
    await expect(newestCandidate.callTool('probe', {})).resolves.toBe('newest-ok');
    await expect(staleCandidate.callTool('probe', {})).rejects.toThrow('stale:closed');
  });

  it('提交后的旧客户端清理失败按计数报告，不回滚已发布候选', async () => {
    const events: string[] = [];
    const oldClient = client('old', events);
    oldClient.close = () => { events.push('close:old'); throw new Error('locked'); };
    const candidate = client('candidate', events);
    let published: McpClient[] = [oldClient];

    const result = await reloadMcpRuntime({
      current: published,
      connect: async () => [candidate],
      synchronize: () => events.push('synchronize'),
      publish: clients => { events.push('publish'); published = clients; },
    });

    expect(result.cleanupFailures).toBe(1);
    expect(events).toEqual(['synchronize', 'publish', 'close:old']);
    expect(published).toEqual([candidate]);
  });

  it('publishes the replacement but waits for an in-flight old-client lease before cleanup completes', async () => {
    const events: string[] = [];
    const releaseCall = deferred<string>();
    let active = 0;
    const oldClient = client('old', events);
    oldClient.callTool = async () => {
      active++;
      try { return await releaseCall.promise; }
      finally { active--; }
    };
    oldClient.close = async () => {
      events.push('close-request:old');
      while (active > 0) await new Promise(resolve => setTimeout(resolve, 5));
      events.push('close:old');
    };
    const candidate = client('candidate', events);
    let published: McpClient[] = [oldClient];
    const invocation = oldClient.callTool('probe', {});

    const reload = reloadMcpRuntime({
      current: published,
      connect: async () => [candidate],
      synchronize: () => events.push('synchronize'),
      publish: clients => { events.push('publish'); published = clients; },
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(published).toEqual([candidate]);
    expect(events).toEqual(['synchronize', 'publish', 'close-request:old']);
    releaseCall.resolve('old-ok');
    await expect(invocation).resolves.toBe('old-ok');
    await reload;
    expect(events).toEqual(['synchronize', 'publish', 'close-request:old', 'close:old']);
  });
});
