// tests/wave3/w3-memory-gateway.test.ts — W3 Memory：Gateway method 统一入口 + scope 只能来自可信 request.sessionId
import { describe, expect, it } from 'vitest';
import { createGatewayService } from '../../src/application/createGatewayService.js';
import { createMemoryGatewayMethods } from '../../src/application/memory/memoryGatewayMethods.js';
import type { MemoryService } from '../../src/application/memoryService.js';

// 内存 repository：tier 隔离语义在 P0-05 已锁定——本测聚焦 gateway 层的 scope 来源与分派。
const memoryService = (sessionId: string): MemoryService => {
  const records: Array<{ id: string; content: string; owner: string }> = [];
  return {
    append: input => {
      const record = { id: `m${records.length + 1}`, content: input.content, owner: sessionId } as never;
      records.push(record as never);
      return { ok: true as const, value: { record, deduplicated: false } };
    },
    update: (id, patch) => {
      const hit = records.find(r => r.id === id);
      if (!hit || hit.owner !== sessionId) {
        return { ok: false, error: { code: 'MEMORY_SCOPE_DENIED', message: 'x', messageKey: 'x', retryable: false } };
      }
      hit.content = patch.content ?? hit.content;
      return { ok: true as const, value: hit as never };
    },
    delete: id => {
      const hit = records.find(r => r.id === id);
      if (!hit || hit.owner !== sessionId) {
        return { ok: false, error: { code: 'MEMORY_SCOPE_DENIED', message: 'x', messageKey: 'x', retryable: false } };
      }
      return { ok: true as const, value: undefined };
    },
    search: input => ({ ok: true as const, value: records.filter(r => r.owner === sessionId && r.content.includes(input.text)).map(r => ({ record: r as never, score: 1, components: { fts: 1, vector: 0, recency: 1, salience: 0.5, sourceTrust: 1, scopeWeight: 1 } })) }),
    list: input => ({ ok: true as const, value: records.filter(r => r.owner === sessionId).slice(0, input.limit ?? 20) as never }),
  };
};

const services = new Map<string, MemoryService>();
const ports = {
  serviceFor: (sessionId: string) => {
    let service = services.get(sessionId);
    if (!service) {
      service = memoryService(sessionId);
      services.set(sessionId, service);
    }
    return service;
  },
};

const service = createGatewayService(createMemoryGatewayMethods(ports));
const request = (method: string, sessionId: string, params: Record<string, unknown>) =>
  service.request({ method, params, sessionId, source: 'wire', correlationId: 'c1' });

describe('memory gateway methods', () => {
  it('appends through the gateway with scope bound to the trusted request sessionId', async () => {
    const result = await request('memory.append', 'session-a', { text: '黑洞引擎' });
    expect(result).toMatchObject({ ok: true });
  });

  it('ignores a forged sessionId inside params (scope can only come from request context)', async () => {
    await request('memory.append', 'session-a', { text: '秘密 A', sessionId: 'session-b' });
    // session-b 视角搜不到 session-a 的内容——params 里的伪造 sessionId 从未生效
    const search = await request('memory.search', 'session-b', { text: '秘密' });
    expect(search.ok).toBe(true);
    if (search.ok) expect(search.value).toHaveLength(0);
    const ownerView = await request('memory.search', 'session-a', { text: '秘密' });
    expect(ownerView.ok && ownerView.value).toHaveLength(1);
  });

  it('fails closed on missing text for append/search', async () => {
    expect(await request('memory.append', 's', {})).toMatchObject({ ok: false, error: { code: 'MEMORY_TEXT_REQUIRED' } });
    expect(await request('memory.search', 's', {})).toMatchObject({ ok: false, error: { code: 'MEMORY_SEARCH_TEXT_REQUIRED' } });
  });

  it('cross-session update/delete is denied at the service boundary', async () => {
    const appended = await request('memory.append', 'session-a', { text: '条目' });
    expect(appended.ok).toBe(true);
    const update = await request('memory.update', 'session-b', { id: 'm1', text: '篡改' });
    expect(update).toMatchObject({ ok: false, error: { code: 'MEMORY_SCOPE_DENIED' } });
    const del = await request('memory.delete', 'session-b', { id: 'm1' });
    expect(del).toMatchObject({ ok: false, error: { code: 'MEMORY_SCOPE_DENIED' } });
  });

  it('unknown methods still fail closed through the dispatcher', async () => {
    const result = await request('memory.ghost', 's', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'GATEWAY_METHOD_UNKNOWN' } });
  });
});
