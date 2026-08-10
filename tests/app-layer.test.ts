// tests/app-layer.test.ts — L5 编排层：zustand 状态/TurnController/Bridge/CommandBus
import { describe, it, expect, beforeEach } from 'vitest';
import { useTurn, patchTurn, getTurn, resetTurn, pushSegment, upsertTool } from '../src/app/stores/turnStore.js';
import { useUi, patchUi, getUi } from '../src/app/stores/uiStore.js';
import { useOverlay, patchOverlay, getOverlay, resetFlowOverlays } from '../src/app/stores/overlayStore.js';
import { turnController } from '../src/app/TurnController.js';
import { createBridge } from '../src/app/Bridge.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeEach(() => {
  resetTurn();
  patchUi({ busy: false, stage: 'idle', mode: 'auto', model: '', contextPct: 0, clock: '', sessionId: null, cwd: process.cwd(), themeName: 'kimi', notice: null });
  patchOverlay({ approval: null, clarify: null, confirm: null, sessions: false, pager: null });
});

describe('zustand 状态层', () => {
  it('patchTurn 增量更新', () => {
    patchTurn({ streaming: 'hello' });
    patchTurn({ streaming: 'hello world' });
    expect(getTurn().streaming).toBe('hello world');
  });
  it('pushSegment 追加消息段', () => {
    pushSegment({ id: '1', role: 'assistant', text: 'a' });
    pushSegment({ id: '2', role: 'assistant', text: 'b' });
    expect(getTurn().streamSegments.length).toBe(2);
  });
  it('upsertTool 同名替换', () => {
    upsertTool({ name: 'bash', ctx: 'pwd', startedAt: 1, done: false });
    upsertTool({ name: 'bash', ctx: 'pwd', startedAt: 1, done: true, ok: true });
    expect(getTurn().tools.length).toBe(1);
    expect(getTurn().tools[0].done).toBe(true);
  });
  it('patchUi 状态切换', () => {
    patchUi({ busy: true, stage: 'work' });
    expect(getUi().busy).toBe(true);
    expect(getUi().stage).toBe('work');
  });
  it('overlay 流程弹层重置（保留会话面板）', () => {
    patchOverlay({ approval: { title: 't', detail: 'd', allowPermanent: true }, sessions: true });
    resetFlowOverlays();
    expect(getOverlay().approval).toBeNull();
    expect(getOverlay().sessions).toBe(true);
  });
});

describe('TurnController', () => {
  it('startMessage 清场并置 busy', () => {
    turnController.startMessage();
    expect(getTurn().busy).toBe(true);
    expect(getUi().stage).toBe('work');
  });
  it('recordDelta 累积 + flushSegment 生成段', () => {
    turnController.startMessage();
    turnController.recordDelta('你');
    turnController.recordDelta('好');
    turnController.flushSegment();
    expect(getTurn().streamSegments.length).toBe(1);
    expect(getTurn().streamSegments[0].text).toBe('你好');
    expect(getTurn().streaming).toBe('');
  });
  it('工具生命周期（start/progress/complete）', () => {
    turnController.startMessage();
    turnController.recordToolStart('bash', 'pwd');
    turnController.recordToolProgress('bash', 'pwd', '运行中');
    turnController.recordToolComplete('bash', 'pwd', true, 'done', 1200);
    const t = getTurn().tools[0];
    expect(t.done).toBe(true);
    expect(t.ok).toBe(true);
    expect(getTurn().turnTrail[0]).toContain('bash');
  });
  it('interruptTurn 保留 partial 并标记', () => {
    turnController.startMessage();
    turnController.recordDelta('部分');
    turnController.interruptTurn();
    expect(getTurn().interrupted).toBe(true);
    expect(getTurn().busy).toBe(false);
  });
  it('recordError 入错误段并中断', () => {
    turnController.startMessage();
    turnController.recordError('模型失败');
    const seg = getTurn().streamSegments[0];
    expect(seg.error).toBe(true);
    expect(getTurn().busy).toBe(false);
  });
});

describe('Bridge（kernel 事件 → stores）', () => {
  it('onToken 映射 recordDelta', () => {
    const b = createBridge({ send: async () => {}, abort: async () => {} });
    b.emit('agent.token', { text: '你' });
    b.emit('agent.token', { text: '好' });
    expect(getTurn().streaming).toBe('你好');
  });
  it('onTool 映射生命周期', () => {
    const b = createBridge({ send: async () => {}, abort: async () => {} });
    b.emit('agent.tool', { name: 'bash', ctx: 'pwd', phase: 'start' });
    b.emit('agent.tool', { name: 'bash', ctx: 'pwd', phase: 'complete', ok: true, detail: 'done', ms: 500 });
    expect(getTurn().tools[0].done).toBe(true);
  });
  it('onStage/onSystem 映射', () => {
    const b = createBridge({ send: async () => {}, abort: async () => {} });
    b.emit('agent.stage', { stage: 'verify' });
    expect(getUi().stage).toBe('verify');
    b.emit('agent.error', { message: '注意：xxx' });
    expect(getTurn().streamSegments.some(s => s.error)).toBe(true);
  });
  it('submit 调用 kernel.send', async () => {
    let sent = '';
    const b = createBridge({ send: async (t) => { sent = t; }, abort: async () => {} });
    await b.submit('你好');
    expect(sent).toBe('你好');
    expect(getTurn().busy).toBe(true);
  });
});

describe('CommandBus 执行器', () => {
  it('注册处理器并执行（带参数）', async () => {
    const bus = createCommandBus();
    bus.register('/echo', async (args) => `echo:${args.join(',')}`);
    const r = await bus.execute('/echo 你好 世界');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('echo:你好,世界');
  });
  it('未注册命令返回 notfound', async () => {
    const bus = createCommandBus();
    const r = await bus.execute('/nope');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未知');
  });
  it('处理器抛错被捕获', async () => {
    const bus = createCommandBus();
    bus.register('/boom', async () => { throw new Error('爆炸'); });
    const r = await bus.execute('/boom');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('爆炸');
  });
  it('别名解析（/帮助 → /help）', async () => {
    const bus = createCommandBus();
    let hit = '';
    bus.register('/help', async () => { hit = '/help'; return 'ok'; });
    await bus.execute('/帮助');
    expect(hit).toBe('/help');
  });
});

// ── M4：/undo 与 /fork 定位当前会话（硬编码 'default' 回归防护）──
describe('/undo 当前会话定位', () => {
  it('切换会话后 /undo 归档活跃会话消息而非 default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-undo-'));
    try {
      const { openDB, closeDB } = await import('../src/store/db.js');
      const { createMemory } = await import('../src/kernel/memory.js');
      const { createEventBus } = await import('../src/kernel/events.js');
      const { registerExtHandlers } = await import('../src/commands/handlersExt.js');
      const db = openDB(dir);
      const mem = createMemory(db);
      const bus = createEventBus(dir);
      const bus2 = createCommandBus();
      let active = 's-active';
      const ctx: any = {
        dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}), getKey: () => undefined },
        bus: createEventBus(dir),
        agent: { getSessionId: () => active, setSessionId: (id: string) => { active = id; } },
        getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {},
        getThemeName: () => 'wxnodus', requestExit: () => {}, clearHistory: () => {},
        setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
      };
      registerExtHandlers(bus2, ctx);
      // 预置：default 有消息，活跃会话 s-active 也有消息
      mem.append('default', 'user', '旧会话问题');
      mem.append('default', 'assistant', '旧会话回答');
      mem.append('s-active', 'user', '活跃会话问题');
      mem.append('s-active', 'assistant', '活跃会话回答');
      // /undo list 应显示活跃会话轮次
      const listR = await bus2.execute('/undo list');
      expect(listR.ok).toBe(true);
      expect(listR.output).toContain('活跃会话问题');
      expect(listR.output).not.toContain('旧会话问题');
      // 执行撤销 → 只归档活跃会话
      const r = await bus2.execute('/undo 1');
      expect(r.ok).toBe(true);
      const activeLeft = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='s-active' AND archived=0`).get() as any;
      const defLeft = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='default' AND archived=0`).get() as any;
      expect(activeLeft.c).toBe(0); // 活跃会话被撤销
      expect(defLeft.c).toBe(2);    // default 不受影响
      closeDB(db);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 延迟解锁，忽略 */ }
    }
  });
});
