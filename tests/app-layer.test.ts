// tests/app-layer.test.ts — L5 编排层：zustand 状态/TurnController/Bridge/CommandBus
import { describe, it, expect, beforeEach } from 'vitest';
import { useTurn, patchTurn, getTurn, resetTurn, pushSegment, upsertTool } from '../src/app/stores/turnStore.js';
import { useUi, patchUi, getUi } from '../src/app/stores/uiStore.js';
import { useOverlay, patchOverlay, getOverlay, resetFlowOverlays } from '../src/app/stores/overlayStore.js';
import { turnController } from '../src/app/TurnController.js';
import { createBridge } from '../src/app/Bridge.js';
import { commandCompletion, createCommandBus } from '../src/app/CommandBus.js';
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
    expect(r.completionStatus).toBe('failed');
  });
  it('V4 L0-5（B-29）：信息词文案不再误判失败；密钥未配置仍 blocked', async () => {
    const bus = createCommandBus();
    bus.register('/bad-text', async () => '部署前置验证失败：缺少 health probe');  // 信息性输出
    bus.register('/status-text', async () => '当前状态：未配置模型密钥（可用 /model set-key 配置）');
    // 「失败：缺少…」是信息文案——不再按内容猜 failed（显式 commandCompletion 才失败）
    await expect(bus.execute('/bad-text')).resolves.toMatchObject({ ok: true });
    // 「当前状态：未配置…」是状态描述句（非确定性引导前缀）——不再 blocked；
    // 密钥未配置的真实引导在 agent 层（结构化），不靠文本猜测
    await expect(bus.execute('/status-text')).resolves.toMatchObject({ ok: true });
  });
  it('处理器因执行信号中止抛错时返回 cancelled', async () => {
    const bus = createCommandBus();
    const controller = new AbortController();
    bus.register('/wait', async (_args, _raw, context) => {
      controller.abort();
      expect(context.signal).toBe(controller.signal);
      throw new DOMException('aborted', 'AbortError');
    });
    const r = await bus.execute('/wait', { signal: controller.signal });
    expect(r).toMatchObject({ ok: false, completionStatus: 'cancelled' });
  });
  it('结构化 completion 保留非成功终态和错误', async () => {
    const bus = createCommandBus();
    bus.register('/partial', async () => commandCompletion('仅完成一部分', 'incomplete', '子任务失败'));
    const r = await bus.execute('/partial');
    expect(r).toEqual({
      ok: false,
      output: '仅完成一部分',
      error: '子任务失败',
      completionStatus: 'incomplete',
    });
  });
  it('结构化 completion 仅 succeeded 映射 ok=true', async () => {
    const bus = createCommandBus();
    bus.register('/done', async () => commandCompletion('完成', 'succeeded'));
    const r = await bus.execute('/done');
    expect(r).toEqual({ ok: true, output: '完成', completionStatus: 'succeeded' });
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

// ── /mcp add/remove 热重载接通（P3：无需重启生效）──
describe('/mcp 热重载', () => {
  it('user and project mutations preserve complete validated MCP entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-mcp-fidelity-'));
    try {
      const { openDB, closeDB } = await import('../src/store/db.js');
      const { createMemory } = await import('../src/kernel/memory.js');
      const { createEventBus } = await import('../src/kernel/events.js');
      const { registerExtHandlers } = await import('../src/commands/handlersExt.js');
      const { loadProjectMcpConfig, loadUserMcpConfig, saveMcpConfig, saveProjectMcpConfig } = await import('../src/kernel/mcp.js');
      const userHttp = {
        name: 'user-http', command: '', url: 'https://mcp.example.test/rpc',
        startupTimeoutMs: 111, timeoutMs: 222, toolDanger: { deploy: true },
      };
      const projectStdio = {
        name: 'project-stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'fixture' },
        startupTimeoutMs: 333, timeoutMs: 444, toolDanger: { remove: true },
      };
      saveMcpConfig(dir, [userHttp]);
      saveProjectMcpConfig(dir, [projectStdio]);

      const db = openDB(dir);
      const bus2 = createCommandBus();
      const ctx: any = {
        dataDir: dir, cwd: dir, db, mem: createMemory(db),
        config: { get: () => ({}), getKey: () => undefined },
        bus: createEventBus(dir), agent: { getSessionId: () => 'default' },
        reloadMcp: async () => ({ ok: true, count: 3, message: 'ok' }),
        getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {},
        getThemeName: () => 'wxnodus', requestExit: () => {}, clearHistory: () => {},
        setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
      };
      registerExtHandlers(bus2, ctx);

      expect((await bus2.execute('/mcp add user-new node user.js')).ok).toBe(true);
      expect((await bus2.execute('/mcp add --project project-new node project.js')).ok).toBe(true);
      expect(loadUserMcpConfig(dir)).toEqual([userHttp, { name: 'user-new', command: 'node', args: ['user.js'] }]);
      expect(loadProjectMcpConfig(dir)).toEqual([projectStdio, { name: 'project-new', command: 'node', args: ['project.js'] }]);

      expect((await bus2.execute('/mcp remove user-new')).ok).toBe(true);
      expect((await bus2.execute('/mcp remove project-new')).ok).toBe(true);
      expect(loadUserMcpConfig(dir)).toEqual([userHttp]);
      expect(loadProjectMcpConfig(dir)).toEqual([projectStdio]);
      closeDB(db);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 延迟解锁 */ }
    }
  });

  it('add 后调用 reloadMcp 并反馈在线数；list 不触发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-mcp-'));
    try {
      const { openDB, closeDB } = await import('../src/store/db.js');
      const { createMemory } = await import('../src/kernel/memory.js');
      const { createEventBus } = await import('../src/kernel/events.js');
      const { registerExtHandlers } = await import('../src/commands/handlersExt.js');
      const db = openDB(dir);
      const mem = createMemory(db);
      const bus2 = createCommandBus();
      let reloadCalls = 0;
      const ctx: any = {
        dataDir: dir, cwd: process.cwd(), db, mem,
        config: { get: () => ({}), getKey: () => undefined },
        bus: createEventBus(dir),
        agent: { getSessionId: () => 'default' },
        reloadMcp: async () => { reloadCalls++; return { ok: true, count: 1, message: 'ok' }; },
        getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {},
        getThemeName: () => 'wxnodus', requestExit: () => {}, clearHistory: () => {},
        setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
      };
      registerExtHandlers(bus2, ctx);
      const r1 = await bus2.execute('/mcp list');
      expect(r1.ok).toBe(true);
      expect(reloadCalls).toBe(0); // 只读命令不触发
      const r2 = await bus2.execute('/mcp add demo node -e x');
      expect(r2.ok).toBe(true);
      expect(r2.output).toContain('热重载');
      expect(r2.output).toContain('1 个在线');
      expect(reloadCalls).toBe(1);
      const r3 = await bus2.execute('/mcp remove demo');
      expect(r3.output).toContain('热重载');
      expect(reloadCalls).toBe(2);
      // 配置确实写盘
      const { loadMcpConfig } = await import('../src/kernel/mcp.js');
      expect(loadMcpConfig(dir)).toEqual([]);
      closeDB(db);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 延迟解锁 */ }
    }
  });
});

// ── /security 安全注入通道：开关 + 关闭即清缓存 ──
describe('/security 通道管理', () => {
  it('sudo on → 状态开启；off → 关闭并清除内存密码', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-sec-'));
    try {
      const { openDB, closeDB } = await import('../src/store/db.js');
      const { createMemory } = await import('../src/kernel/memory.js');
      const { createEventBus } = await import('../src/kernel/events.js');
      const { createSecretVault } = await import('../src/kernel/secrets.js');
      const { registerExtHandlers } = await import('../src/commands/handlersExt.js');
      const db = openDB(dir);
      const mem = createMemory(db);
      const bus2 = createCommandBus();
      const secrets = createSecretVault();
      let persisted: Record<string, any> = {};
      const ctx: any = {
        dataDir: dir, cwd: process.cwd(), db, mem, secrets,
        config: {
          get: () => ({ security: persisted }),
          getKey: () => undefined,
          setKey: (_s: string, _k: string, v: any) => { persisted = v; },
        },
        bus: createEventBus(dir),
        agent: { getSessionId: () => 'default' },
        getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {},
        getThemeName: () => 'wxnodus', requestExit: () => {}, clearHistory: () => {},
        setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
      };
      registerExtHandlers(bus2, ctx);
      secrets.setSudoPassword('cached-pw'); // 预置缓存
      const on = await bus2.execute('/security sudo on');
      expect(on.ok).toBe(true);
      expect(persisted.sudoInjection).toBe(true);
      const status1 = await bus2.execute('/security status');
      expect(status1.output).toContain('开启');
      const off = await bus2.execute('/security sudo off');
      expect(off.output).toContain('清除');
      expect(persisted.sudoInjection).toBe(false);
      expect(secrets.getSudoPassword()).toBeNull(); // 关闭即清（红线）
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 延迟解锁 */ }
    }
  });

  it('secret off → 清除全部内存密钥；all off → clearAll', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-sec2-'));
    try {
      const { openDB, closeDB } = await import('../src/store/db.js');
      const { createMemory } = await import('../src/kernel/memory.js');
      const { createEventBus } = await import('../src/kernel/events.js');
      const { createSecretVault } = await import('../src/kernel/secrets.js');
      const { registerExtHandlers } = await import('../src/commands/handlersExt.js');
      const db = openDB(dir);
      const mem = createMemory(db);
      const bus2 = createCommandBus();
      const secrets = createSecretVault();
      let persisted: Record<string, any> = {};
      const ctx: any = {
        dataDir: dir, cwd: process.cwd(), db, mem, secrets,
        config: { get: () => ({ security: persisted }), getKey: () => undefined, setKey: (_s: string, _k: string, v: any) => { persisted = v; } },
        bus: createEventBus(dir),
        agent: { getSessionId: () => 'default' },
        getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {},
        getThemeName: () => 'wxnodus', requestExit: () => {}, clearHistory: () => {},
        setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
      };
      registerExtHandlers(bus2, ctx);
      secrets.setSecret('A', '1');
      secrets.setSecret('B', '2');
      await bus2.execute('/security secret off');
      expect(secrets.secretNames()).toEqual([]);
      secrets.setSudoPassword('pw');
      secrets.setSecret('C', '3');
      const all = await bus2.execute('/security all off');
      expect(all.output).toContain('清空');
      expect(secrets.getSudoPassword()).toBeNull();
      expect(secrets.secretNames()).toEqual([]);
      closeDB(db);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 延迟解锁 */ }
    }
  });
});

// V4 L0-5（B-29）：文本终态推断仅保留确定性前缀——信息词（不可用/未找到/无法/超时等）
// 不再误判 failed（/doctor「组件不可用」/mcp list 信息行 → headless 退出码 0）。
describe('V4 L0-5 inferTextCompletion 信息词废除（B-29）', () => {
  it('信息性文案不再推断为 failed/blocked（退出码 0，CI 不误判）', async () => {
    const { createCommandBus } = await import('../src/app/CommandBus.js');
    const bus = createCommandBus();
    bus.register('/doctor', () => '网络组件探测：不可用（离线模式）');
    bus.register('/mcp.list', () => 'server-a: 未找到配置');
    const r1 = await bus.execute('/doctor');
    const r2 = await bus.execute('/mcp.list');
    expect(r1.ok).toBe(true);
    expect(r1.completionStatus ?? 'succeeded').toBe('succeeded');
    expect(r2.ok).toBe(true);
  });
  it('确定性前缀仍正确终态（取消/拒绝/红线）', async () => {
    const { createCommandBus } = await import('../src/app/CommandBus.js');
    const bus = createCommandBus();
    bus.register('/x', () => '命令已取消');
    const r = await bus.execute('/x');
    expect(r.ok).toBe(false);
    expect(r.completionStatus).toBe('cancelled');
  });
});
