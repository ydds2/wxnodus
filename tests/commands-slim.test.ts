// tests/commands-slim.test.ts — supremacy 1.6 命令面瘦身（A-01）：两层命令面契约
// 覆盖：主干 47 条 / 扩展 70 条（2026-08-19 实测 SLASH 117，并集 = SLASH 全集，零删除）；/help 默认只列主干 +
// 扩展计数提示；/help all 全目录；单命令详情标注扩展层；command_search 主干优先排序
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLASH, CORE_COMMANDS, extendedCommands, isCoreCommand, searchCommandCatalog } from '../src/commands/registry.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { registerCoreHandlers } from '../src/commands/handlers.js';
import type { HandlerCtx } from '../src/commands/handlers.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-slim-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('两层命令面（主干/扩展）', () => {
  it('主干 47 条 + 扩展层 = SLASH 全集（零删除契约，扩展数随命令增减漂移——断言恒等式）', () => {
    expect(CORE_COMMANDS.size).toBe(47);
    const ext = extendedCommands();
    expect(ext.length).toBe(SLASH.length - CORE_COMMANDS.size);
    expect(new Set([...CORE_COMMANDS, ...ext]).size).toBe(SLASH.length);
    // 主干全部真实注册（不是虚构命令）
    for (const c of CORE_COMMANDS) expect(SLASH).toContain(c);
  });
  it('主干覆盖日常驾驶面（每类都有代表）', () => {
    for (const c of ['/help', '/sessions', '/model', '/memory', '/build', '/perm', '/sandbox', '/config', '/img', '/claw', '/cron', '/calc', '/map']) {
      expect(isCoreCommand(c), c).toBe(true);
    }
    // 扩展层样例（进阶/别名/低频——照常可用）
    for (const c of ['/bench', '/self-evolve', '/fortune', '/a2a', '/base64']) {
      expect(isCoreCommand(c), c).toBe(false);
      expect(SLASH).toContain(c);
    }
  });
});

describe('/help 渲染（默认主干 / all 全目录）', () => {
  const makeBus = async () => {
    const dir = tmp();
    const db = openDB(dir);
    const bus = createCommandBus();
    const ctx = {
      db, bus: createEventBus(dir), mem: createMemory(db),
      getMode: () => 'smart' as const, setMode: () => {}, getSettings: () => ({}),
      clearHistory: () => {},
    } as unknown as HandlerCtx;
    registerCoreHandlers(bus, ctx);
    return { bus, close: () => closeDB(db) };
  };

  it('默认：只列主干命令 + 扩展计数提示；不含扩展命令行', async () => {
    const { bus, close } = await makeBus();
    const out = (await bus.execute('/help')).output;
    expect(out).toContain('主干 47 个');
    expect(out).toContain('扩展命令');
    expect(out).toContain('/help all 查看全部');
    expect(out).toContain('/build');
    expect(out).not.toContain('      /bench'); // 扩展命令默认不渲染成行（计数提示除外）
    close();
  });
  it('/help all：全目录渲染（扩展命令行可见）', async () => {
    const { bus, close } = await makeBus();
    const out = (await bus.execute('/help all')).output;
    expect(out).toContain('全目录');
    expect(out).toContain('/bench');
    close();
  });
  it('单命令详情：扩展层标注', async () => {
    const { bus, close } = await makeBus();
    expect((await bus.execute('/help bench')).output).toContain('扩展命令');
    expect((await bus.execute('/help build')).output).not.toContain('扩展命令');
    close();
  });
});

describe('command_search 主干优先（AI 目录检索面）', () => {
  it('同分命中：主干排在扩展之前（tier 标注）', () => {
    // '/im' 前缀命中 /img（主干，score 3）与 /import（扩展，score 2）——分数不同；
    // 用关键词「抓取」命中 /claw（主干，描述含抓取）与 /web（扩展，描述含抓取）验证同分主干优先
    const hits = searchCommandCatalog('抓取', 20);
    const claw = hits.findIndex(h => h.name === '/claw');
    const web = hits.findIndex(h => h.name === '/web');
    expect(claw).toBeGreaterThanOrEqual(0);
    expect(web).toBeGreaterThanOrEqual(0);
    expect(claw).toBeLessThan(web); // 主干 /claw 在别名 /web 之前
    expect(hits.find(h => h.name === '/web')!.tier).toBe('extended');
  });
  it('空查询：主干全目录兜底（模型盲查询时拿到日常驾驶面）', () => {
    const hits = searchCommandCatalog('');
    expect(hits.length).toBe(8);
    for (const h of hits) expect(h.tier).toBe('core');
  });
});
