// tests/wave3/w3-memory-shadow.test.ts — W3 Memory 影子双写契约（RED）
// 决策：影子双写、观察后切换——agent 写消息时同步影子写显式记忆记录（session scope）；
// legacy append 是唯一行为事实源（影子失败只计数、绝不上抛）；report 诚实声明召回仍走 legacy。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../src/store/db.js';
import { createMemory } from '../../src/kernel/memory.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import { createMemoryShadow } from '../../src/application/memory/memoryShadow.js';

const dir = mkdtempSync(join(tmpdir(), 'w3-mem-shadow-'));
const db = openDB(dir);
const repository = openMemoryRepository(db, {
  now: () => Date.now(),
  idFactory: prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
});
const legacy = createMemory(db);
const shadow = createMemoryShadow({ legacy, repository, db });

afterAll(() => {
  try { closeDB(db); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('W3 memory shadow double-write', () => {
  it('appends the legacy message AND a session-scoped modern record', () => {
    shadow.append('s1', 'user', '用户说了偏好：深色主题');
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id='s1'`).get() as { c: number }).c).toBe(1);
    expect((db.prepare(
      `SELECT COUNT(*) c FROM memory_records WHERE scope_tier='session' AND scope_key='s1' AND tombstoned_at IS NULL`,
    ).get() as { c: number }).c).toBe(1);
  });

  it('identical consecutive messages dedup to a single modern record (contentHash)', () => {
    shadow.append('s1', 'user', '重复内容重复内容重复内容重复内容');
    shadow.append('s1', 'user', '重复内容重复内容重复内容重复内容');
    expect((db.prepare(
      `SELECT COUNT(*) c FROM memory_records WHERE scope_tier='session' AND scope_key='s1' AND tombstoned_at IS NULL`,
    ).get() as { c: number }).c).toBe(2); // 偏好 1 条 + 重复内容 1 条
  });

  it('shadow failures are counted and never break the legacy append', () => {
    const failing = createMemoryShadow({
      legacy,
      repository: { append: () => { throw new Error('boom'); } } as never,
      db,
    });
    failing.append('s2', 'user', '影子失败不阻断');
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id='s2'`).get() as { c: number }).c).toBe(1);
    const report = failing.shadowReport('s2');
    expect(report.shadowFailures).toBe(1);
    expect(report.lastError).toContain('boom');
    expect(report.legacyMessages).toBe(1);
    expect(report.shadowRecords).toBe(0);
  });

  it('report is truthful and declares legacy recall during the observation window', () => {
    const report = shadow.shadowReport('s1');
    expect(report).toMatchObject({ sessionId: 's1', recallSource: 'legacy' });
    expect(report.legacyMessages).toBeGreaterThanOrEqual(1);
    expect(report.shadowRecords).toBeGreaterThanOrEqual(1);
    expect(report.shadowAppends).toBeGreaterThanOrEqual(2);
    expect(report.shadowFailures).toBe(0);
  });

  it('delegates the rest of the legacy surface untouched', () => {
    shadow.append('s3', 'assistant', '回答内容');
    expect(shadow.working('s3').length).toBe(1);
    expect(shadow.absorbCount('s3')).toBe(0);
    expect(shadow.setTitleIfEmpty('s3', '标题')).toBeUndefined();
    expect(typeof shadow.repository()).toBe('object');
  });
});
