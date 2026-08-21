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
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) {
        // V4 P2-9：产物须本轮新建（基线拦截——任务前产物不再算本轮验证对象）
        mkdirSync(join(d, 'projects', 'p-demo-new'), { recursive: true });
        return { ok: true, text: '✓ 已完成：构建完成', turns: 1, interrupted: false };
      }
      return { ok: true, text: '继续推进：补充测试', turns: 1, interrupted: false };
    });
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

// V4 P2-9：/goal 假完成根治——裸 ✅ 不触发验证；仅本轮新建/变更产物参与验证。
describe('V4 P2-9 假完成根治', () => {
  it('文本中间含 ✅（非行首完成声明）→ 不触发完成验证（继续循环或达上限 incomplete）', async () => {
    const d = tmp();
    const bus = createEventBus(d);
    const calls: string[] = [];
    const run = vi.fn(async (prompt: string) => { calls.push(prompt); return { ok: true, text: '本轮完成清单：✅ 读取文件 ✅ 修改配置——还差最后一步' }; });
    const { ctx, db } = makeCtx(d, bus, run);
    try {
      const commandBus = createCommandBus();
      registerExtHandlers(commandBus, ctx);
      const r = await commandBus.execute('/goal 测试目标 2');
      // ✅ 在句中非行首 → 不判完成声明 → 2 轮跑满 incomplete（不触发产物验证）
      expect(run).toHaveBeenCalledTimes(2);
      expect(r.completionStatus ?? 'incomplete').toBe('incomplete');
      expect(String(r.output)).not.toMatch(/验证通过|验证未通过|本轮无新建/);
    } finally { closeDB(db); }
  });

  it('基线拦截：声称完成但最新项目为任务前基线 → 不验证不判完成（旧项目假完成根除）', async () => {
    const d = tmp();
    mkdirSync(join(d, 'projects', 'p-old'), { recursive: true });
    const bus = createEventBus(d);
    const run = vi.fn(async () => ({ ok: true, text: '✓ 已完成：全部做完' }));
    const { ctx, db } = makeCtx(d, bus, run);
    try {
      const commandBus = createCommandBus();
      registerExtHandlers(commandBus, ctx);
      const r = await commandBus.execute('/goal 建项目 1');
      expect(String(r.output)).toContain('本轮无新建/变更产物');
      expect(r.completionStatus ?? 'incomplete').toBe('incomplete');
    } finally { closeDB(db); }
  });

  it('行首 ✓ 已完成 + 本轮新建项目 → 进入验证（合法路径不被误伤）', async () => {
    const d = tmp();
    mkdirSync(join(d, 'projects', 'p-old'), { recursive: true });
    const bus = createEventBus(d);
    // 首轮建新项目（写目录模拟），次轮声称完成
    let round = 0;
    const run = vi.fn(async () => {
      round += 1;
      if (round === 1) { mkdirSync(join(d, 'projects', 'p-new-20260821'), { recursive: true }); return { ok: true, text: '已创建项目骨架' }; }
      return { ok: true, text: '✓ 已完成：项目构建成功' };
    });
    const { ctx, db } = makeCtx(d, bus, run);
    try {
      const commandBus = createCommandBus();
      registerExtHandlers(commandBus, ctx);
      await commandBus.execute('/goal 建新项目 2');
      // 第二轮触发验证（p-new ≠ 基线 p-old——进入 verifyProject；项目无 package.json 验证失败但不假绿）
      expect(String(round)).toBe('2');
    } finally { closeDB(db); }
  });
});
