// tests/kernel-memory.test.ts — L2-2 黑洞引擎：三层记忆/吸附/召回/压缩/token 估算
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createMemory, estimateTokens, compactKeepHeadTail } from '../src/kernel/memory.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-mem-'));
  db = openDB(dir);
  mem = createMemory(db);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('token 估算', () => {
  it('CJK=1/字，ASCII≈1/4', () => {
    expect(estimateTokens('黑洞引擎')).toBe(4);
    expect(estimateTokens('hello')).toBe(2); // 5 * 0.25 ≈ 2
  });
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('三层记忆（working/archival/recall）', () => {
  it('写入消息入 recall（全量永不删）', () => {
    mem.append('s1', 'user', '第一句话');
    mem.append('s1', 'assistant', '回复内容');
    const all = mem.recall('s1');
    expect(all.length).toBe(2);
    expect(all[0].content).toBe('第一句话');
  });

  it('working 超压自动吸附（黑洞：>8 条吸旧入 archival）', () => {
    const m = createMemory(db, { workingLimit: 8 });
    for (let i = 0; i < 12; i++) m.append('s2', i % 2 === 0 ? 'user' : 'assistant', `消息${i} 黑洞引擎测试`);
    const w = m.working('s2');
    expect(w.length).toBeLessThanOrEqual(8); // 吸附后窗口受限
    expect(m.absorbCount('s2')).toBeGreaterThan(0); // 确有吸附
  });

  it('吸附后 recall 仍全量', () => {
    const all = mem.recall('s2');
    expect(all.length).toBe(12); // 永不删
  });
});

describe('混合召回（FTS5 中文）', () => {
  it('中文关键词召回命中（吸附进 archival 的也能搜到）', async () => {
    const hits = await mem.recallHybrid('黑洞引擎', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });
  it('无关词零命中', async () => {
    expect((await mem.recallHybrid('xyzzy不存在', { limit: 5 })).length).toBe(0);
  });
});

describe('记忆置顶/淡化（salience 加权召回）', () => {
  it('pin 置顶后召回分数放大、排序提前', async () => {
    const m = createMemory(db, { workingLimit: 20 });
    m.append('s3', 'user', '项目红线：密钥必须加密存储');
    m.append('s3', 'assistant', '普通回复内容');
    const rec = m.recall('s3');
    const target = rec[0]!; // 第一条（红线）
    expect(m.setSalience(target.id, 3)).toBe(true);
    const salient = m.listSalient();
    expect(salient.some(s => s.id === target.id && s.salience === 3)).toBe(true);
    // 召回：置顶的红线命中的 score 应高于未置顶的同词命中
    const hits = await m.recallHybrid('密钥 加密', { limit: 5 });
    const pinned = hits.find(h => h.id === target.id);
    expect(pinned).toBeDefined();
    expect(pinned!.score).toBeGreaterThan(1); // 1（FTS 基准）× 3（salience）
  });
  it('fade 淡化后权重压低；reset 还原', async () => {
    const m = createMemory(db, { workingLimit: 20 });
    m.append('s4', 'user', '一次性的临时内容');
    const rec = m.recall('s4');
    const target = rec[0]!;
    expect(m.setSalience(target.id, 0.3)).toBe(true);
    expect(m.listSalient().some(s => s.id === target.id)).toBe(false); // <1 不进置顶列表
    const hits = await m.recallHybrid('临时内容', { limit: 5 });
    const faded = hits.find(h => h.id === target.id);
    expect(faded).toBeDefined();
    expect(faded!.score).toBeLessThan(1); // 0.3 × 1
    expect(m.setSalience(target.id, 1)).toBe(true);
    expect(m.listSalient().some(s => s.id === target.id)).toBe(false);
  });
  it('不存在的消息 id → false', () => {
    expect(mem.setSalience(999999, 3)).toBe(false);
  });
});

describe('压缩（上下文窗口管理）', () => {
  it('compactKeepHeadTail 保头尾丢中部', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: `消息${i}` }));
    const out = compactKeepHeadTail(msgs, { head: 3, tail: 3 });
    expect(out.length).toBe(6);
    expect(out[0].content).toBe('消息0');
    expect(out[out.length - 1].content).toBe('消息9');
    expect(out.some(m => m.content === '消息5')).toBe(false); // 中部被丢
  });
  it('消息不足时不压缩', () => {
    const msgs = [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }];
    expect(compactKeepHeadTail(msgs, { head: 3, tail: 3 }).length).toBe(2);
  });
});

describe('embedding 降级', () => {
  it('无 embedding 模型时向量检索降级 FTS（不抛）', async () => {
    // WXN_NO_EMBED 时 recallHybrid 内部跳过向量只走 FTS
    process.env.WXN_NO_EMBED = '1';
    const hits = await mem.recallHybrid('第一句话', { limit: 5 });
    expect(Array.isArray(hits)).toBe(true);
    delete process.env.WXN_NO_EMBED;
  });
});

// ── P3b：compactSmart 归档语义（F6 不硬删 + 摘要原位）───
describe('compactSmart 归档', () => {
  it('LLM 摘要成功后：中部消息归档（recall 全量保留）而非删除', async () => {
    const m = createMemory(db, { workingLimit: 20 });
    for (let i = 0; i < 12; i++) m.append('s-c1', i % 2 === 0 ? 'user' : 'assistant', `压缩消息${i} 测试`);
    await m.compactSmart('s-c1', async () => '（摘要）关键信息保留');
    // recall 全量仍在（不硬删）
    const all = m.recall('s-c1');
    expect(all.length).toBe(12 + 0); // 12 条（摘要写进原位，未新增未删除）
    // 归档计数增加
    expect(m.absorbCount('s-c1')).toBeGreaterThan(0);
    // 摘要写入第一条中部消息原位（system 角色）
    const systemRow = all.find(r => r.role === 'system');
    expect(systemRow).toBeDefined();
    expect(String(systemRow?.content ?? '')).toContain('摘要');
  });
  it('LLM 摘要失败时降级：归档中部（不删除）', async () => {
    const m = createMemory(db, { workingLimit: 20 });
    for (let i = 0; i < 12; i++) m.append('s-c2', i % 2 === 0 ? 'user' : 'assistant', `降级消息${i}`);
    await m.compactSmart('s-c2', async () => { throw new Error('LLM 不可用'); });
    const all = m.recall('s-c2');
    expect(all.length).toBe(12); // 永不删
    expect(m.absorbCount('s-c2')).toBeGreaterThan(0); // 中部归档
  });
});
