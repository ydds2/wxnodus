// tests/kernel-task-models.test.ts — supremacy 1.2 小模型任务档：解析 + 标题/摘要生成 + agent 自动标题降级契约
// 覆盖：resolveTaskModel 槽位隔离、generateTitle/generateSummary 清洗与异常降级、
// agent 回合末标题：小模型生成 → 回退切片 → 已有标题零调用（查库门）→ 注入器抛出不崩溃
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createAgent } from '../src/kernel/agent.js';
import { resolveTaskModel, generateTitle, generateSummary } from '../src/kernel/taskModels.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-taskm-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

const seedSession = (id: string, title: string) => {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
    .run(id, title, Date.now(), Date.now());
};
const titleOf = (id: string) =>
  (db.prepare(`SELECT title FROM sessions WHERE id=?`).get(id) as { title: string } | undefined)?.title ?? '';

describe('resolveTaskModel（槽位解析）', () => {
  it('title/summary 槽位独立解析（空/未配置 → null）', () => {
    expect(resolveTaskModel({ titleModel: ' deepseek-chat ' }, 'title')).toBe('deepseek-chat');
    expect(resolveTaskModel({ summaryModel: 'kimi-k3' }, 'summary')).toBe('kimi-k3');
    expect(resolveTaskModel({}, 'title')).toBeNull();
    expect(resolveTaskModel({ titleModel: '' }, 'title')).toBeNull();
    expect(resolveTaskModel(undefined, 'title')).toBeNull();
    // 交叉读取：titleModel 不进 summary 槽
    expect(resolveTaskModel({ titleModel: 'a' }, 'summary')).toBeNull();
  });
});

describe('generateTitle / generateSummary（纯函数）', () => {
  it('generateTitle 传系统+用户提示、剥引号、≤20 字', async () => {
    const calls: Array<[string, string]> = [];
    const t = await generateTitle('帮我写一个待办系统', async (sys, usr) => {
      calls.push([sys, usr]);
      return '「待办系统搭建」';
    });
    expect(t).toBe('待办系统搭建');
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain('标题');
    expect(calls[0]![1]).toContain('待办系统');
  });
  it('generateTitle 超长截 20 字；空/异常 → null（诚实降级）', async () => {
    const long = await generateTitle('x', async () => '一二三四五六七八九十一二三四五六七八九十多余');
    expect(long).toBe('一二三四五六七八九十一二三四五六七八九十');
    expect(await generateTitle('x', async () => '')).toBeNull();
    expect(await generateTitle('x', async () => { throw new Error('boom'); })).toBeNull();
  });
  it('generateSummary 截 200 字；异常 → null', async () => {
    // '要点' 为 2 字：200 字符 = ×100
    const s = await generateSummary('内容'.repeat(500), async () => '要点'.repeat(300));
    expect(s).toBe('要点'.repeat(100));
    expect(await generateSummary('x', async () => { throw new Error('x'); })).toBeNull();
  });
});

describe('agent 自动标题（supremacy 1.2 小模型任务档）', () => {
  const runToEnd = (id: string, titleGenerator?: (p: string) => Promise<string | null>) => {
    const agent = createAgent({
      db, bus, mem, sessionId: id,
      config: { settings: {} } as any,
      callModel: async () => ({ type: 'text', content: '这是回答内容' }),
      titleGenerator,
    });
    return agent.run('请帮我搭建一个待办系统');
  };

  it('注入 titleGenerator → 标题用小模型生成值', async () => {
    seedSession('tm1', '');
    const r = await runToEnd('tm1', async () => '待办系统搭建');
    expect(r.ok).toBe(true);
    expect(titleOf('tm1')).toBe('待办系统搭建');
  });
  it('titleGenerator 返回 null → 回退首行切片（原版行为）', async () => {
    seedSession('tm2', '');
    await runToEnd('tm2', async () => null);
    expect(titleOf('tm2')).toBe('请帮我搭建一个待办系统');
  });
  it('未注入 titleGenerator → 切片标题（零漂移）', async () => {
    seedSession('tm3', '');
    await runToEnd('tm3');
    expect(titleOf('tm3')).toBe('请帮我搭建一个待办系统');
  });
  it('已有标题 → 不触发 titleGenerator 调用（查库门，不浪费小模型请求）', async () => {
    seedSession('tm4', '已有标题');
    let calls = 0;
    await runToEnd('tm4', async () => { calls++; return '不应覆盖'; });
    expect(calls).toBe(0);
    expect(titleOf('tm4')).toBe('已有标题');
  });
  it('titleGenerator 抛出 → 回退切片，回合不崩溃', async () => {
    seedSession('tm5', '');
    const r = await runToEnd('tm5', async () => { throw new Error('小模型挂了'); });
    expect(r.ok).toBe(true);
    expect(titleOf('tm5')).toBe('请帮我搭建一个待办系统');
  });
});
