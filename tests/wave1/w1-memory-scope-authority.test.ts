// tests/wave1/w1-memory-scope-authority.test.ts — P0-05：memory 应用服务 scope 权威
// scope 只来自注入的可信 context，input 无法伪造 session；跨 scope update/delete 拒绝；global 读取显式 opt-in。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../../src/store/db.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import { createMemoryService, type MemoryService } from '../../src/application/memoryService.js';
import type { AppendMemory } from '../../src/domain/memory/memoryRepository.js';

const append = (content: string): AppendMemory => ({
  role: 'user',
  content,
  salience: 0.5,
  retention: { class: 'session', retainUntil: null },
  provenance: {
    sourceType: 'conversation',
    sourceId: 'turn-1',
    capturedAt: new Date().toISOString(),
    actorId: 'actor-1',
    correlationId: 'corr-1',
    policySnapshotId: 'policy-1',
    sourceTrust: 1,
  },
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wxnodus-memory-scope-'));
  const db = openDB(dir);
  const now = Date.now();
  const repository = openMemoryRepository(db, { now: () => now, idFactory: prefix => `${prefix}-${Math.random().toString(36).slice(2)}` });
  const serviceFor = (context: Parameters<typeof createMemoryService>[1]): MemoryService =>
    createMemoryService(repository, context);
  return { dir, db, serviceFor, repository };
}

describe('memory service scope authority', () => {
  it('never lets a search input forge the session scope', () => {
    const { dir, db, serviceFor } = setup();
    try {
      const serviceA = serviceFor({ sessionId: 'session-a' });
      const serviceB = serviceFor({ sessionId: 'session-b' });
      const writtenA = serviceA.append(append('alpha-marker'));
      const writtenB = serviceB.append(append('beta-marker'));
      expect(writtenA.ok).toBe(true);
      expect(writtenB.ok).toBe(true);

      const hitsA = serviceA.search({ text: 'marker' });
      expect(hitsA.ok).toBe(true);
      if (!hitsA.ok) throw new Error(hitsA.error.code);
      expect(hitsA.value.map(hit => hit.record.content)).toContain('alpha-marker');
      expect(hitsA.value.map(hit => hit.record.content)).not.toContain('beta-marker');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects append without any declared scope', () => {
    const { dir, db, serviceFor } = setup();
    try {
      const service = serviceFor({});
      expect(service.append(append('无作用域'))).toMatchObject({ ok: false, error: { code: 'MEMORY_SCOPE_REQUIRED' } });
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects cross-scope update and delete with MEMORY_SCOPE_DENIED', () => {
    const { dir, db, serviceFor } = setup();
    try {
      const serviceA = serviceFor({ sessionId: 'session-a' });
      const serviceB = serviceFor({ sessionId: 'session-b' });
      const written = serviceA.append(append('归属会话 A 的记录'));
      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error(written.error.code);
      const id = written.value.record.id;

      expect(serviceB.update(id, { content: '越权修改' })).toMatchObject({ ok: false, error: { code: 'MEMORY_SCOPE_DENIED' } });
      expect(serviceB.delete(id)).toMatchObject({ ok: false, error: { code: 'MEMORY_SCOPE_DENIED' } });
      expect(serviceA.update(id, { content: '本 scope 修改' })).toMatchObject({ ok: true });
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads global memory only with explicit opt-in', () => {
    const { dir, db, serviceFor } = setup();
    try {
      const globalService = serviceFor({ globalOptIn: true });
      const sessionService = serviceFor({ sessionId: 'session-a' });
      const written = globalService.append(append('gamma-marker'));
      expect(written.ok).toBe(true);

      const sessionHits = sessionService.search({ text: 'gamma' });
      expect(sessionHits.ok).toBe(true);
      if (!sessionHits.ok) throw new Error(sessionHits.error.code);
      expect(sessionHits.value).toHaveLength(0);

      const optInService = serviceFor({ sessionId: 'session-a', globalOptIn: true });
      const optInHits = optInService.search({ text: 'gamma' });
      expect(optInHits.ok).toBe(true);
      if (!optInHits.ok) throw new Error(optInHits.error.code);
      expect(optInHits.value.map(hit => hit.record.content)).toContain('gamma-marker');
    } finally {
      closeDB(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
