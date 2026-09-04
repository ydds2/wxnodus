// tests/kernel-memory-recency.test.ts — C5（2026-09-04 第四批）：黑洞召回时间衰减契约
// 机制：recallHybrid 排序加 recency 因子（指数半衰期 7 天、地板 0.1、会话内不衰减）。
// 验收（master plan C5）：新旧记忆召回序实测——跨会话新记忆置前、旧记忆让位不消失、
// 会话内序不受时间影响。ts 由测试直接改库控制（append 写的是墙钟，无注入 seam）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createMemory } from '../src/kernel/memory.js';

let db: ReturnType<typeof openDB>;
let mem: ReturnType<typeof createMemory>;
let dir: string;
const DAY = 86_400_000;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-recency-'));
  db = openDB(join(dir, 'm.db'));
  mem = createMemory(db);
});
afterAll(() => { closeDB(db); try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY */ } });

/** 直接改库调 ts——append 写墙钟，时间旅行走 SQL（测试专用，不动生产 seam） */
const setTime = (id: number, ageDays: number) =>
  db.prepare('UPDATE messages SET ts=? WHERE id=?').run(Date.now() - ageDays * DAY, id);

const lastId = () => Number((db.prepare('SELECT MAX(id) AS m FROM messages').get() as { m: number }).m);

describe('C5：recallHybrid 时间衰减（半衰期 7 天 · 地板 0.1 · 会话内不衰减）', () => {
  it('跨会话：同 salience 新旧两条 → 新记忆置前（旧记忆让位不消失）', async () => {
    const sidOld = 'recency-old', sidNew = 'recency-new';
    mem.append(sidOld, 'assistant', '部署检查清单：先跑 wxn-ci 全量门禁再发布');
    setTime(lastId(), 30); // 30 天前
    mem.append(sidNew, 'assistant', '部署检查清单：先跑 wxn-ci 快速门禁再灰度');
    setTime(lastId(), 0.1); // 约 2.4 小时前
    const r = await mem.recallHybrid('部署检查清单', { limit: 5 });
    expect(r.length).toBeGreaterThanOrEqual(2);
    // 新记忆（灰度）在前；旧记忆（发布）仍在列表（地板 0.1——让位不消失）
    expect(r[0]!.content).toContain('灰度');
    expect(r.find(x => x.content.includes('发布'))).toBeTruthy();
  });

  it('半衰期数值：14 天前记忆 score ≈ 0.25×salience（0.5^(14/7)）', async () => {
    const sid = 'recency-half';
    mem.append(sid, 'assistant', '半衰期标定样本：wxn-ci-half-life-marker');
    const id = lastId();
    setTime(id, 14);
    const r = await mem.recallHybrid('wxn-ci-half-life-marker', { limit: 3 });
    const hit = r.find(x => x.id === id);
    expect(hit, '14 天前记忆必须仍可召回（地板语义）').toBeTruthy();
    expect(hit!.score).toBeCloseTo(0.25, 1); // 0.5^2 × salience 1
  });

  it('地板：一年前的记忆仍可召回（score = 0.1×salience——绝不归零）', async () => {
    const sid = 'recency-floor';
    mem.append(sid, 'assistant', '远古锚点样本：wxn-ci-ancient-floor-marker');
    const id = lastId();
    setTime(id, 365);
    const r = await mem.recallHybrid('wxn-ci-ancient-floor-marker', { limit: 3 });
    const hit = r.find(x => x.id === id);
    expect(hit, '一年前记忆仍可召回').toBeTruthy();
    expect(hit!.score).toBeCloseTo(0.1, 2); // 地板 0.1
  });

  it('会话内（opts.sessionId 给定）：时间不参与排序——session scope 不变', async () => {
    const sid = 'recency-in-session';
    mem.append(sid, 'assistant', '会话内旧话：wxn-ci-session-old-marker');
    setTime(lastId(), 90);
    mem.append(sid, 'assistant', '会话内新话：wxn-ci-session-new-marker');
    setTime(lastId(), 0.01);
    const r = await mem.recallHybrid('wxn-ci-session', { limit: 5, sessionId: sid });
    // 会话内 recency 恒为 1——两条都命中时按 FTS rank 序（不因 90 天差距压分）；
    // 断言语义：两条都在（时间不淘汰），且分数不受年龄影响（均无衰减因子）
    const old = r.find(x => x.content.includes('session-old'));
    const fresh = r.find(x => x.content.includes('session-new'));
    expect(old).toBeTruthy();
    expect(fresh).toBeTruthy();
    expect(old!.score).toBeCloseTo(fresh!.score, 5); // 同 salience 同衰减（=1）——分差为零
  });
});
