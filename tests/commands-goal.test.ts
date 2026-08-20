// tests/commands-goal.test.ts — /goal 开放目标循环：fail-closed 验证 + 中断 + 无 key 死分支修复
// 驱动：fake ctx + registerExtHandlers（照 commands.test.ts 模式）——命令层全链路
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-goal-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const makeCtx = (d: string, evBus: ReturnType<typeof createEventBus>, run: any) => {
  const db = openDB(d);
  const ctx = {
    dataDir: d, cwd: process.cwd(), db, mem: createMemory(db), bus: evBus,
    config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
    agent: { run },
    getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {}, getThemeName: () => 'wxnodus',
    requestExit: () => {}, clearHistory: () => {}, setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
  } as any;
  return { ctx, db };
};

describe('/goal 目标循环（fail-closed 诚实交付）', () => {
  it('声称完成但无产物 → 不判完成 + 输出含「未验证」+ 不空转（KF-023 语义）', async () => {
    const d = tmp();
    const bus = createCommandBus();
    const evBus = createEventBus(d);
    const run = vi.fn(async () => ({ ok: true, text: '✓ 已完成：系统就绪', turns: 1, interrupted: false }));
    const { ctx, db } = makeCtx(d, evBus, run);
    registerExtHandlers(bus, ctx);
    const r = await bus.execute('/goal 做一个待办系统');
    expect(r.ok).toBe(false);
    expect(r.completionStatus).toBe('incomplete');
    expect(r.output).toContain('未验证');
    expect(r.output).not.toContain('目标执行 ✓ 完成');
    expect(run).toHaveBeenCalledTimes(1); // 不空转剩余轮次
    expect(run).toHaveBeenCalledWith(expect.anything(), { goalLoop: false, signal: undefined }); // 关闭内核 goal 内层循环并贯通取消
    closeDB(db);
  });

  it('有产物但验证失败 → 追加警告继续下一轮（不假绿）', async () => {
    const d = tmp();
    // 构造 projects/p-xxx 产物目录（无 server/index.js → verifyProject 确定性 failed）
    mkdirSync(join(d, 'projects', 'p-demo'), { recursive: true });
    const bus = createCommandBus();
    const evBus = createEventBus(d);
    const run = vi.fn(async () =>
      run.mock.calls.length === 1
        ? { ok: true, text: '✓ 已完成：构建完成', turns: 1, interrupted: false }
        : { ok: true, text: '继续推进：补充测试', turns: 1, interrupted: false });
    const { ctx, db } = makeCtx(d, evBus, run);
    registerExtHandlers(bus, ctx);
    const r = await bus.execute('/goal 做一个待办系统 2');
    expect(r.ok).toBe(false);
    expect(r.completionStatus).toBe('incomplete');
    expect(r.output).toContain('验证未通过');
    expect(r.output).toContain('第 2 轮');
    expect(run).toHaveBeenCalledTimes(2);
    closeDB(db);
  });

  it('r.interrupted → 循环停止 + agent.goal 收尾事件 cancelled', async () => {
    const d = tmp();
    const bus = createCommandBus();
    const evBus = createEventBus(d);
    const emitSpy = vi.spyOn(evBus, 'emit');
    const run = vi.fn(async () => ({ ok: false, text: '被中断', turns: 1, interrupted: true }));
    const { ctx, db } = makeCtx(d, evBus, run);
    registerExtHandlers(bus, ctx);
    const r = await bus.execute('/goal 长任务');
    expect(r.ok).toBe(false);
    expect(r.completionStatus).toBe('cancelled');
    expect(r.output).toContain('已取消');
    expect(run).toHaveBeenCalledTimes(1);
    const finalGoalEvent = emitSpy.mock.calls.find(([name, p]) => name === 'agent.goal' && (p as any).cancelled === true);
    expect(finalGoalEvent).toBeTruthy();
    closeDB(db);
  });

  it('无 key 文本 → 立即 break 不空转（去掉恒假 !r.ok 前置）', async () => {
    const d = tmp();
    const bus = createCommandBus();
    const evBus = createEventBus(d);
    const run = vi.fn(async () => ({ ok: false, text: '未配置模型密钥——/key set 后重试', turns: 1, interrupted: false }));
    const { ctx, db } = makeCtx(d, evBus, run);
    registerExtHandlers(bus, ctx);
    const r = await bus.execute('/goal 目标 5');
    expect(r.ok).toBe(false);
    expect(r.completionStatus).toBe('blocked');
    expect(r.output).toContain('未配置模型密钥');
    expect(run).toHaveBeenCalledTimes(1);
    closeDB(db);
  });
});

describe('goal 护栏明示', () => {
  it('无护栏配置 → 提示开 auto-stop/budget；全开 → ✓ 不提示', async () => {
    const { registerExtHandlers } = await import('../src/commands/handlersExt.js');
    const { createCommandBus } = await import('../src/app/CommandBus.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const { createMemory } = await import('../src/kernel/memory.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const d = mkdtempSync(join(tmpdir(), 'wx-goal-'));
    const db = openDB(d);
    // 最小护栏配置：无 balanceMonitor.autoStop、无 budgetTokens
    const makeBus = (settings: Record<string, any>) => {
      const ctx = {
        dataDir: d, cwd: process.cwd(), db, mem: createMemory(db), bus: createEventBus(d),
        config: { get: () => ({ ...settings }), getKey: (_s: string, k: string) => settings[k], setKey: () => {} },
        agent: {
          getSessionId: () => 'g1',
          run: async () => ({ ok: true, text: '✓ 已完成 目标达成', turns: 1, interrupted: false }),
        },
      } as any;
      const bus = createCommandBus();
      registerExtHandlers(bus, ctx);
      return bus;
    };
    try {
      const r1 = await makeBus({}).execute('/goal 测试目标 1');
      expect(String(r1.output)).toContain('/balance auto-stop on');
      const r2 = await makeBus({ balanceMonitor: { autoStop: true }, budgetTokens: 80000, budgetStop: true }).execute('/goal 测试目标 1');
      expect(String(r2.output)).toContain('auto-stop 开 ✓');
      expect(String(r2.output)).toContain('硬停 ✓');
      expect(String(r2.output)).not.toContain('防超支');
    } finally {
      closeDB(db);
      rmSync(d, { recursive: true, force: true });
    }
  });
});
