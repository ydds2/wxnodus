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
  it('中文关键词召回命中（吸附进 archival 的也能搜到）', () => {
    const hits = mem.recallHybrid('黑洞引擎', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });
  it('无关词零命中', () => {
    expect(mem.recallHybrid('xyzzy不存在', { limit: 5 }).length).toBe(0);
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
    const hits = mem.recallHybrid('第一句话', { limit: 5 });
    expect(Array.isArray(hits)).toBe(true);
    delete process.env.WXN_NO_EMBED;
  });
});
