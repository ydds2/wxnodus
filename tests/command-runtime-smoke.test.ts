// tests/command-runtime-smoke.test.ts — 反虚假常驻冒烟（2026-08-19 审计落定）
// 断言：① SLASH 每条命令经别名解析后有真实 handler（执行不落「未知命令」）
//      ② 无参数执行全部命令：不抛异常、不假失败（白名单：需参数的子命令集除外）
//      ③ 无参数执行不挂起（单命令 5s 上界）
// 驱动：fake ctx + registerCore/ExtHandlers（照 commands-goal.test.ts 模式）；cwd 指向小临时目录
// （/snapshot 等目录遍历命令对仓库根会真实慢——用受控目录保持全量执行可行）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLASH, resolveAlias } from '../src/commands/registry.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { registerCoreHandlers } from '../src/commands/handlers.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import type { HandlerCtx } from '../src/commands/handlers.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-smoke-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function buildBus() {
  const d = tmp();
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'hello.txt'), 'hello wxnodus\n');
  const db = openDB(d);
  const evBus = createEventBus(d);
  const ctx = {
    dataDir: d, cwd: d, db, mem: createMemory(db), bus: evBus,
    config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
    getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {}, getThemeName: () => 'wxnodus',
    requestExit: () => {}, clearHistory: () => {}, setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
  } as unknown as HandlerCtx;
  const bus = createCommandBus();
  registerCoreHandlers(bus, ctx);
  registerExtHandlers(bus, ctx);
  return bus;
}

// 无参数执行会挂起/需参数的子命令集（诚实白名单——这些命令的语义就是「等待输入/打开界面/网络」，
// 无参数语义在对应专项测试覆盖，不在本冒烟范围内）
const SKIP_NO_ARG = new Set<string>([
  '/quit',        // requestExit → process.exit 语义
  '/update',      // 网络探测
  '/voice',       // 组件探测（无参数语义为状态展示，专项测试覆盖）
]);

describe('命令运行时冒烟（反虚假：注册即真实可执行）', () => {
  it('SLASH 全量经别名解析后有真实 handler（无「未知命令」空洞）', () => {
    const bus = buildBus();
    const registered = new Set(bus.list());
    const unresolved = SLASH.filter((c) => !registered.has(c) && !registered.has(resolveAlias(c)) && c !== '/rewind'); // /rewind 为 ALIAS_INJECT（→/checkpoint restore）
    expect(unresolved, `注册表有命令但无 handler（含别名目标）: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('SLASH 全量无参数执行：不抛异常、不假失败、不挂起（单命令 5s 上界）', async () => {
    const bus = buildBus();
    const problems: string[] = [];
    for (const cmd of SLASH) {
      if (SKIP_NO_ARG.has(cmd)) continue;
      const t0 = Date.now();
      let r: Awaited<ReturnType<ReturnType<typeof createCommandBus>['execute']>>;
      try {
        r = await Promise.race([
          bus.execute(cmd),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG')), 5000)),
        ]);
      } catch (e: any) {
        problems.push(`${cmd} → ${e?.message === 'HANG' ? `挂起 >5s（${Date.now() - t0}ms）` : `throw: ${e?.message ?? e}`}`);
        continue;
      }
      if (!r.ok) problems.push(`${cmd} → error: ${r.error}`);
    }
    expect(problems, `命令执行问题:\n${problems.join('\n')}`).toEqual([]);
  }, 120000);
});
