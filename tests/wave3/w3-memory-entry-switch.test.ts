// tests/wave3/w3-memory-entry-switch.test.ts — W3 Memory 入口切换契约（RED → modern 权威层）
// /memory 与 memory_* 工具已切到 session-scoped MemoryService（scope 只来自可信 ToolCtx.sessionId）；
// 本测锁定：list 作用域隔离 + 工具「增删改查」全闭环走 modern（绝不回落 legacy messages）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDB, openDB } from '../../src/store/db.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import { createMemoryService } from '../../src/application/memoryService.js';
import { coreTools } from '../../src/kernel/tools.js';
import { salienceFlag, salienceFromMultiplier } from '../../src/commands/memorySalience.js';

const dir = mkdtempSync(join(tmpdir(), 'w3-mem-entry-'));
const db = openDB(dir);
const repository = openMemoryRepository(db, {
  now: () => Date.now(),
  idFactory: prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
});
const svc = (sessionId: string) => createMemoryService(repository, { sessionId });
const provenance = (sessionId: string) => ({
  sourceType: 'tool' as const, sourceId: sessionId, sourceUri: undefined,
  capturedAt: new Date().toISOString(), actorId: sessionId, correlationId: 't',
  policySnapshotId: 't', sourceTrust: 1,
});
const append = (sessionId: string, role: 'user' | 'assistant', content: string) =>
  svc(sessionId).append({ role, content, salience: 0.5, retention: { class: 'session' as const, retainUntil: null }, provenance: provenance(sessionId) });

afterAll(() => {
  try { closeDB(db); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('W3 memory entry switch', () => {
  it('list returns session-scoped active records (scope isolation)', () => {
    append('sA', 'user', '会话 A 的记录');
    append('sB', 'user', '会话 B 的记录');
    const a = svc('sA').list({ limit: 20 });
    const b = svc('sB').list({ limit: 20 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) {
      expect(a.value.length).toBeGreaterThanOrEqual(1);
      expect(a.value.every(r => r.scopeKey === 'sA')).toBe(true);
      expect(a.value.some(r => r.scopeKey === 'sB')).toBe(false);
    }
  });

  it('memory_* 工具「增删改查」全闭环走 modern（不回 legacy messages）', async () => {
    const tools = coreTools();
    const ctx = { db, sessionId: 'sTool' } as never;
    const tag = `入口切换${Date.now()}`;
    const write = await tools.memory_write!.run({ content: `${tag}：初始版本` }, ctx);
    expect(write).toContain('已写入长期记忆');

    const search1 = await tools.memory_search!.run({ query: tag }, ctx);
    expect(search1).toContain('初始版本');
    const id = /\[(memory-[^\]]+)\]/.exec(String(search1))?.[1];
    expect(id).toBeTruthy();

    const update = await tools.memory_update!.run({ id, content: `${tag}：纠正版本` }, ctx);
    expect(update).toContain('已更新记忆');
    const search2 = await tools.memory_search!.run({ query: tag }, ctx);
    expect(search2).toContain('纠正版本');

    const del = await tools.memory_delete!.run({ id }, ctx);
    expect(del).toContain('已删除记忆');
    const search3 = await tools.memory_search!.run({ query: tag }, ctx);
    expect(search3).toContain('未检索到');

    // 关键断言：全程未触碰 legacy messages 表（入口已切走）
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id='memory-archive'`).get() as { c: number }).c).toBe(0);
  });

  it('跨会话工具检索隔离（scope 只来自 ToolCtx.sessionId）', async () => {
    const tools = coreTools();
    append('sX', 'user', '跨会话隔离探针词');
    const hitsX = await tools.memory_search!.run({ query: '隔离探针' }, { db, sessionId: 'sX' } as never);
    expect(hitsX).toContain('历史记忆命中');
    const hitsY = await tools.memory_search!.run({ query: '隔离探针' }, { db, sessionId: 'sY' } as never);
    expect(hitsY).toContain('未检索到');
  });

  it('salience 更新（pin/fade 数据路径）经 modern update + 倍率映射', () => {
    // legacy 倍率语义 → modern salience[0,1] 单调映射（1→0.5 默认、3→0.75 置顶、0.3→0.23 淡化）
    expect(salienceFromMultiplier(1)).toBeCloseTo(0.5);
    expect(salienceFromMultiplier(3)).toBeCloseTo(0.75);
    expect(salienceFromMultiplier(0.3)).toBeCloseTo(0.2307);
    expect(salienceFlag(0.75)).toBe('★');
    expect(salienceFlag(0.5)).toBe(' ');
    expect(salienceFlag(0.23)).toBe('☆');
    const r = append('sPin', 'assistant', '需要置顶的约束');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pin = svc('sPin').update(r.value.record.id, { salience: salienceFromMultiplier(3) });
    expect(pin.ok).toBe(true);
    if (pin.ok) expect(pin.value.salience).toBeCloseTo(0.75);
  });
});
