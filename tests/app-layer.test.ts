// tests/app-layer.test.ts — L5 编排层：zustand 状态/TurnController/Bridge/CommandBus
import { describe, it, expect, beforeEach } from 'vitest';
import { useTurn, patchTurn, getTurn, resetTurn, pushSegment, upsertTool } from '../src/app/stores/turnStore.js';
import { useUi, patchUi, getUi } from '../src/app/stores/uiStore.js';
import { useOverlay, patchOverlay, getOverlay, resetFlowOverlays } from '../src/app/stores/overlayStore.js';
import { turnController } from '../src/app/TurnController.js';
import { createBridge } from '../src/app/Bridge.js';
import { createCommandBus } from '../src/app/CommandBus.js';

beforeEach(() => {
  resetTurn();
  patchUi({ busy: false, stage: 'idle', mode: 'auto', model: '', contextPct: 0, clock: '', sessionId: null, cwd: process.cwd(), themeName: 'kimi', notice: null });
  patchOverlay({ approval: null, clarify: null, confirm: null, panel: false, sessions: false, pager: null });
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
