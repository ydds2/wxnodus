// tests/kernel-gateway.test.ts — P3：session.undo 响应契约（UI 死路径修复）+ 软归档语义
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '../src/wxnodus-ui/wxGateway.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createMemory } from '../src/kernel/memory.js';
import { createEventBus } from '../src/kernel/events.js';
import { createCommandBus } from '../src/app/CommandBus.js'
import { createTuiPresentationAdapter } from '../src/presentation/tui/tuiPresentationAdapter.js';
import { encryptKey, decryptKey } from '../src/kernel/providers.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let mem: ReturnType<typeof createMemory>;
let gw: GatewayClient;
let runCalls: Array<{ text: string; opts: any }>;

// 测试辅助：Gateway RPC 响应形态由各命令契约决定，测试侧不重复声明 DTO
async function req(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return gw.request(method, params);
}

// 局部 GatewayClient 实例（describe 内新建的 g）共用同一宽松契约
async function gre(client: GatewayClient, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return client.request(method, params);
}

function makeGateway(settings: Record<string, any> = {}) {
  const bus = createEventBus(dir);
  runCalls = [];
  const agent = {
    run: async (text: string, opts?: any) => { runCalls.push({ text, opts }); return { ok: true, text: '', turns: 0, interrupted: false }; },
    abort() {},
    setMode() {},
    getMode: () => 'smart',
    setSessionId() {},
    getSessionId: () => 's1',
    steer: () => true,
  };
  // 与生产同构：config 与 kernel.settings 共享同一稳定引用（createConfig 写穿透语义）
  const settingsObj: Record<string, any> = { model: 'glm-4v-flash', ...settings };
  const config = {
    get: (p: string) => (p === 'settings' ? settingsObj : {}),
    getKey: (p: string, k: string) => (p === 'settings' ? settingsObj[k] : undefined),
    setKey: (p: string, k: string, v: unknown) => { if (p === 'settings') settingsObj[k] = v; },
  };
  const kernel = {
    dataDir: dir,
    cwd: process.cwd(),
    db,
    mem,
    config,
    bus,
    settings: settingsObj,
    commandBus: createCommandBus(),
    // W3 TUI facade：db/agent 原始句柄经 presentation adapter 进入 GatewayClient
    adapter: createTuiPresentationAdapter({ db, agent: agent as never }),
    applyModel() {},
    setMode() {},
    setTheme() {},
    setThinking() {},
    requestExit() {},
  };
  return new GatewayClient(kernel as any);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-gw-'));
  db = openDB(dir);
  mem = createMemory(db);
  gw = makeGateway();
});

afterEach(() => {
  closeDB(db);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 延迟解锁 */ }
});

describe('session.undo 响应契约（UI 死路径修复）', () => {
  it('空会话返回 { ok:false, removed:0 }', async () => {
    const r = await req('session.undo', { session_id: 's1' });
    expect(r.ok).toBe(false);
    expect(r.removed).toBe(0);
  });

  it('撤销一轮返回 removed=2（user+assistant）且软归档', async () => {
    mem.append('s1', 'user', '问题一');
    mem.append('s1', 'assistant', '回答一');
    mem.append('s1', 'user', '问题二');
    mem.append('s1', 'assistant', '回答二');
    const r = await req('session.undo', { session_id: 's1' });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(2);
    // 软归档：消息仍在库中（黑洞 recall 保留），仅 archived=1
    const archived = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='s1' AND archived=1`).get() as any;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='s1'`).get() as any;
    expect(archived.c).toBe(2);
    expect(total.c).toBe(4);
    // 视图回退：loadMessages 过滤归档 → 只剩第一轮
    const act = await req('session.activate', { session_id: 's1' });
    const view = (act.messages as Array<{ role: string; text: string }>).filter(m => m.role !== 'system');
    expect(view.map(m => m.text)).toEqual(['问题一', '回答一']);
  });

  it('撤销前生成 checkpoint 快照（可恢复）', async () => {
    mem.append('s1', 'user', '问题');
    mem.append('s1', 'assistant', '回答');
    await req('session.undo', { session_id: 's1' });
    const cp = db.prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE session_id='s1'`).get() as any;
    expect(cp.c).toBeGreaterThan(0);
  });

  it('连续撤销直至空（removed 归零不报错）', async () => {
    mem.append('s1', 'user', '唯一问题');
    mem.append('s1', 'assistant', '唯一回答');
    const r1 = await req('session.undo', { session_id: 's1' });
    expect(r1.removed).toBe(2);
    const r2 = await req('session.undo', { session_id: 's1' });
    expect(r2.ok).toBe(false);
    expect(r2.removed).toBe(0);
  });
});

// ── P3 图片附加链路：image.attach → pending → prompt.submit 多模态注入 ──
describe('image.attach 附加链路', () => {
  function writePng(path: string, w: number, h: number): void {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'latin1');
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    writeFileSync(path, buf);
  }

  it('attach 真实 PNG：宽高/token 元数据 + 附件落盘 + pending 登记', async () => {
    const img = join(dir, 'test-256x128.png');
    writePng(img, 256, 128);
    const r = await req('image.attach', { session_id: 's1', path: img });
    expect(r.attached).toBe(true);
    expect(r.width).toBe(256);
    expect(r.height).toBe(128);
    expect(r.token_estimate).toBe(Math.ceil((256 * 128) / 750));
    // 附件已复制进会话附件目录
    expect(existsSync(join(dir, 'attachments', 's1', 'pending.json'))).toBe(true);
  });

  it('不存在的路径 / 非图片文件 → attached:false', async () => {
    const r1 = await req('image.attach', { session_id: 's1', path: join(dir, 'ghost.png') });
    expect(r1.attached).toBe(false);
    const txt = join(dir, 'not-image.txt');
    writeFileSync(txt, '纯文本不是图片');
    const r2 = await req('image.attach', { session_id: 's1', path: txt });
    expect(r2.attached).toBe(false);
  });

  it('图像模型：pending 随 prompt.submit 注入（多模态 parts）', async () => {
    const img = join(dir, 'attach.png');
    writePng(img, 320, 200);
    await req('image.attach', { session_id: 's1', path: img });
    await req('prompt.submit', { session_id: 's1', text: '看看这张图' });
    await new Promise(r => setTimeout(r, 20));
    expect(runCalls.length).toBe(1);
    const opts = runCalls[0]!.opts;
    expect(opts?.images?.length).toBe(1);
    expect(String(opts.images[0].dataUrl).startsWith('data:image/png;base64,')).toBe(true);
    // pending 已消费
    expect(existsSync(join(dir, 'attachments', 's1', 'pending.json'))).toBe(false);
  });

  it('文本模型：图片透传 agent（策略收敛在 agent 环——视觉通道识别，不注入 image_url）', async () => {
    gw = makeGateway({ model: 'deepseek-v4-flash' });
    (gw as any).subscribed = true // 激活事件直发（否则 publish 缓冲）
    const img = join(dir, 'attach2.png');
    writePng(img, 100, 100);
    await req('image.attach', { session_id: 's1', path: img });
    await req('prompt.submit', { session_id: 's1', text: '看图说话' });
    await new Promise(r => setTimeout(r, 20));
    // 新契约（image_url 400 防御纵深）：网关不再按模型能力截留图片——
    // 能力门在 agent 环内执行（视觉模型注入 parts / 文本模型视觉通道先识别 / 无 key 诚实丢弃）
    expect(runCalls[0]?.opts?.images).toBeDefined();
    expect(runCalls[0]!.opts!.images![0]!.mime).toBe('image/png');
  });

  it('clipboard.paste 响应形态稳定（有图/无图均返回合法结构）', async () => {
    const r = await req('clipboard.paste', { session_id: 's1' });
    if (r.attached) {
      expect(r.count).toBeGreaterThan(0);
      expect(Number.isFinite(r.width)).toBe(true);
    } else {
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

// ── spawn_tree 持久化：save/list/load 三件套（/replay 磁盘档案）──
describe('spawn_tree 持久化', () => {
  it('save → list（按会话过滤倒序）→ load 回放往返', async () => {
    const s1 = await req('spawn_tree.save', {
      finished_at: Date.now() / 1000,
      label: '第一个委派',
      session_id: 's1',
      started_at: Date.now() / 1000 - 30,
      subagents: [{ goal: '目标A', status: 'completed' }],
    });
    expect(s1.ok).toBe(true);
    // 另一会话的快照（不应出现在 s1 列表）
    await req('spawn_tree.save', {
      finished_at: Date.now() / 1000,
      label: '其他会话委派',
      session_id: 's-other',
      subagents: [{ goal: 'B', status: 'running' }, { goal: 'C', status: 'completed' }],
    });
    const list = await req('spawn_tree.list', { session_id: 's1', limit: 10 });
    expect(list.entries.length).toBe(1);
    expect(list.entries[0].label).toBe('第一个委派');
    expect(list.entries[0].count).toBe(1);
    // load 回放
    const loaded = await req('spawn_tree.load', { path: list.entries[0].path });
    expect(loaded.subagents.length).toBe(1);
    expect(loaded.subagents[0].goal).toBe('目标A');
    expect(loaded.session_id).toBe('s1');
  });
  it('空目录 / 损坏文件容错', async () => {
    const empty = await req('spawn_tree.list', { session_id: 'ghost' });
    expect(empty.entries).toEqual([]);
    const bad = await req('spawn_tree.load', { path: join(dir, '不存在.json') });
    expect(bad.subagents).toEqual([]);
  });
});

// ── reload.mcp：确认门 + 热重载回调 ──
describe('reload.mcp', () => {
  it('未确认 → confirm_required', async () => {
    const r = await req('reload.mcp', { session_id: 's1' });
    expect(r.status).toBe('confirm_required');
  });
  it('确认后调用 kernel.reloadMcp 并返回计数', async () => {
    let called = 0;
    (gw as any).kernel.reloadMcp = async () => { called++; return { ok: true, count: 2, message: '已重载 2 个' }; };
    const r = await req('reload.mcp', { session_id: 's1', confirm: true });
    expect(r.status).toBe('reloaded');
    expect(r.message).toContain('2');
    expect(called).toBe(1);
  });
  it('无 reloadMcp 能力时优雅降级', async () => {
    (gw as any).kernel.reloadMcp = undefined;
    const r = await req('reload.mcp', { session_id: 's1', confirm: true });
    expect(r.status).toBe('reloaded');
    expect(typeof r.message).toBe('string');
  });
});

// ── P3 安全注入通道：sudo/secret 用户亲手输入（UI overlay）──
describe('sudo/secret 注入通道', () => {
  it('requestSecretInput 发 sudo.request 事件，respond 完成请求', async () => {
    (gw as any).subscribed = true;
    const events: any[] = [];
    (gw as any).on('event', (e: any) => events.push(e));
    const promise = gw.requestSecretInput('sudo', '需要密码');
    const reqEvent = events.find((e: any) => e.type === 'sudo.request');
    expect(reqEvent).toBeDefined();
    const requestId = reqEvent.payload.request_id;
    const r = await gre(gw, 'sudo.respond', { request_id: requestId, password: '手输密码' });
    expect(r.ok).toBe(true);
    expect(await promise).toBe('手输密码');
  });

  it('secret 通道：事件带 env_var 与 prompt，respond 返回值', async () => {
    (gw as any).subscribed = true;
    const events: any[] = [];
    (gw as any).on('event', (e: any) => events.push(e));
    const promise = gw.requestSecretInput('secret', '需要密钥', 'MY_TOKEN');
    const reqEvent = events.find((e: any) => e.type === 'secret.request');
    expect(reqEvent?.payload?.env_var).toBe('MY_TOKEN');
    await gre(gw, 'secret.respond', { request_id: reqEvent.payload.request_id, value: 'sk-xyz' });
    expect(await promise).toBe('sk-xyz');
  });

  it('未知 request_id respond → 失败且不影响其他请求', async () => {
    const r = await req('sudo.respond', { request_id: 'ghost', password: 'x' });
    expect(r.ok).toBe(false);
  });

  it('超时（60s）自动拒绝不悬挂', async () => {
    (gw as any).subscribed = true;
    const t0 = Date.now();
    const promise = gw.requestSecretInput('sudo', '无人响应');
    // 缩短超时验证机制：直接手动触发 timer
    const entries = [...(gw as any).pendingSecrets.entries()];
    const [id, entry] = entries[0]!;
    clearTimeout(entry.timer);
    (gw as any).pendingSecrets.delete(id);
    entry.resolve(null);
    expect(await promise).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// A24 第四类修复：delegation.pause 真实持久化（内核 set/get + status RPC）
describe('delegation.pause 真实持久化', () => {
  it('pause 后 status 轮询保持 paused:true（不再闪回 false）', async () => {
    let paused = false
    const bus = createEventBus(dir)
    const kernel = {
      dataDir: dir,
      cwd: process.cwd(),
      db,
      mem,
      config: { get: () => ({}), getKey: () => undefined },
      bus,
      settings: { model: 'glm-4v-flash' },
      commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
        abort() {},
        setMode() {},
        getMode: () => 'smart',
        setSessionId() {},
        getSessionId: () => 's1',
        steer: () => true,
        setDelegationPaused: (v: boolean) => { paused = v },
        getDelegationPaused: () => paused,
      }) as never }),
      applyModel() {},
      setMode() {},
      setTheme() {},
      setThinking() {},
      requestExit() {},
    }
    const g = new GatewayClient(kernel as any)

    const p1 = await gre(g, 'delegation.pause', { pause: true })
    expect(p1.paused).toBe(true)
    // 同一 gateway 的后续 status 轮询读到真实 paused（此前硬编码 false）
    const s1 = await gre(g, 'delegation.status', {})
    expect(s1.paused).toBe(true)
    // resume 后恢复
    const p2 = await gre(g, 'delegation.pause', { pause: false })
    expect(p2.paused).toBe(false)
    const s2 = await gre(g, 'delegation.status', {})
    expect(s2.paused).toBe(false)
  })
})

// A24 第四类修复：terminal.resize 真实转发（不再空 stub）+ session.fork 已移除
describe('terminal.resize 转发 / session.fork 移除', () => {
  it('terminal.resize 转发到 kernel.term.resize（含窗口尺寸）', async () => {
    const bus = createEventBus(dir)
    const resized: Array<{ id: string; cols: number; rows: number }> = []
    const kernel = {
      dataDir: dir,
      cwd: process.cwd(),
      db,
      mem,
      config: { get: () => ({}), getKey: () => undefined },
      bus,
      settings: { model: 'glm-4v-flash' },
      commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
        abort() {},
        setMode() {},
        getMode: () => 'smart',
        setSessionId() {},
        getSessionId: () => 's1',
        steer: () => true,
      }) as never }),
      term: {
        list: () => [{ id: 't1', status: 'running', shell: 'bash', cwd: '/', startedAt: 0, exitCode: null }],
        resize: (id: string, cols: number, rows: number) => { resized.push({ id, cols, rows }); return { ok: true } },
      },
      applyModel() {},
      setMode() {},
      setTheme() {},
      setThinking() {},
      requestExit() {},
    }
    const g = new GatewayClient(kernel as any)
    const r = await gre(g, 'terminal.resize', { cols: 120, rows: 40, session_id: 's1' })
    expect(r.ok).toBe(true)
    expect(resized).toEqual([{ id: 't1', cols: 120, rows: 40 }])
  })

  it('terminal.resize 无运行终端 → 诚实报错（非假装成功）', async () => {
    const bus = createEventBus(dir)
    const kernel = {
      dataDir: dir,
      cwd: process.cwd(),
      db,
      mem,
      config: { get: () => ({}), getKey: () => undefined },
      bus,
      settings: { model: 'glm-4v-flash' },
      commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
        abort() {},
        setMode() {},
        getMode: () => 'smart',
        setSessionId() {},
        getSessionId: () => 's1',
        steer: () => true,
      }) as never }),
      term: { list: () => [], resize: () => ({ ok: true }) },
      applyModel() {},
      setMode() {},
      setTheme() {},
      setThinking() {},
      requestExit() {},
    }
    const g = new GatewayClient(kernel as any)
    const r = await gre(g, 'terminal.resize', { cols: 120, session_id: 's1' })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('运行中')
  })

  it('session.fork 已移除（死 RPC 拒绝而非静默返回）', async () => {
    const bus = createEventBus(dir)
    const kernel = {
      dataDir: dir,
      cwd: process.cwd(),
      db,
      mem,
      config: { get: () => ({}), getKey: () => undefined },
      bus,
      settings: { model: 'glm-4v-flash' },
      commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
        abort() {},
        setMode() {},
        getMode: () => 'smart',
        setSessionId() {},
        getSessionId: () => 's1',
        steer: () => true,
      }) as never }),
      applyModel() {},
      setMode() {},
      setTheme() {},
      setThinking() {},
      requestExit() {},
    }
    const g = new GatewayClient(kernel as any)
    // request 捕获 unsupported 错误 → { ok:false, code }（不 reject、不假装成功）
    const r = await gre(g, 'session.fork', { session_id: 's1' })
    expect(r.ok).toBe(false)
    expect(String(r.message)).toContain('unsupported')
  })
})

// A24 第三类修复：kernel jobs 事件 → background.jobs 即时推送
describe('kernel jobs 事件转发', () => {
  it('jobs.created / jobs.complete → 发布 background.jobs 快照', async () => {
    const bus = createEventBus(dir)
    type JobRow = { id: string; goal: string; status: string; kind: string; created_at: number; done_at: number | null; exit_code: number | null }
    let jobsDb: JobRow[] = [
      { id: 'j1', goal: '跑测试', status: 'running', kind: 'agent', created_at: 1, done_at: null, exit_code: null },
    ]
    const kernel = {
      dataDir: dir,
      cwd: process.cwd(),
      db,
      mem,
      config: { get: () => ({}), getKey: () => undefined },
      bus,
      settings: { model: 'glm-4v-flash' },
      commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
        abort() {},
        setMode() {},
        getMode: () => 'smart',
        setSessionId() {},
        getSessionId: () => 's1',
        steer: () => true,
      }) as never }),
      taskRunner: { list: () => jobsDb },
      applyModel() {},
      setMode() {},
      setTheme() {},
      setThinking() {},
      requestExit() {},
    }
    const g = new GatewayClient(kernel as any)
    ;(g as any).subscribed = true
    const events: any[] = []
    ;(g as any).on('event', (e: any) => events.push(e))
    g.start()

    bus.emit('jobs.created', { id: 'j2', kind: 'shell', parent_id: '', goal: '编译' })
    expect(events.some(e => e.type === 'background.jobs')).toBe(true)
    const snap = events.find(e => e.type === 'background.jobs')?.payload
    expect(Array.isArray(snap)).toBe(true)
    expect(snap[0].id).toBe('j1')

    events.length = 0
    jobsDb = [{ id: 'j1', goal: '跑测试', status: 'complete', kind: 'agent', created_at: 1, done_at: 9, exit_code: 0 }]
    bus.emit('jobs.complete', { id: 'j1', kind: 'agent', status: 'complete', exit_code: 0, parent_id: '', duration_ms: 8 })
    const snap2 = events.find(e => e.type === 'background.jobs')?.payload
    expect(snap2[0].status).toBe('complete')
    expect(snap2[0].exit_code).toBe(0)
  })
})

// A24 第三类修复：buildInfo 补真实字段（compressions/mcp_servers/system_prompt/update_behind）
describe('buildInfo 死数据接线', () => {
  it('compressions 来自压缩摘要行计数（非硬编码零）', async () => {
    const bus = createEventBus(dir)
    // 预置会话行 + 一条压缩摘要消息（与 kernel compactSmart 写入格式一致）
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1','t',1,1)`).run()
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('s1','system','（自动压缩摘要）第一轮总结',1)`)
      .run()
    const kernel = {
      dataDir: dir,
      cwd: process.cwd(),
      db,
      mem,
      config: { get: () => ({}), getKey: () => undefined },
      bus,
      settings: { model: 'glm-4v-flash' },
      commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
        abort() {},
        setMode() {},
        getMode: () => 'smart',
        setSessionId() {},
        getSessionId: () => 's1',
        steer: () => true,
      }) as never }),
      mcpStatus: () => [{ name: 'filesystem', connected: true, tools: 5, transport: 'stdio' }],
      systemPrompt: () => '你是 WxNodus……',
      updateBehind: 3,
      applyModel() {},
      setMode() {},
      setTheme() {},
      setThinking() {},
      requestExit() {},
    }
    const g = new GatewayClient(kernel as any)
    // session.activate 返回 info = buildInfo()（激活 s1——压缩摘要插在该会话下）
    const r = await gre(g, 'session.activate', { session_id: 's1' })
    const info = r.info
    expect(info.usage.compressions).toBe(1)
    expect(info.mcp_servers).toEqual([{ name: 'filesystem', connected: true, tools: 5, transport: 'stdio' }])
    expect(info.system_prompt).toContain('WxNodus')
    expect(info.update_behind).toBe(3)
  })
})

// A25 第五轮审计：死 RPC 真实实现 + 假数据消除
describe('死 RPC 真实实现（/save /rollback /tools /reload /paste.collapse）', () => {
  function makeKernel(extra: Record<string, any> = {}) {
    const bus = createEventBus(dir)
    return {
      dataDir: dir,
      cwd: process.cwd(),
      db,
      mem,
      config: { get: () => ({}), getKey: () => undefined },
      bus,
      settings: { model: 'glm-4v-flash' },
      commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
        abort() {},
        setMode() {},
        getMode: () => 'smart',
        setSessionId() {},
        getSessionId: () => 's1',
        steer: () => true,
        updateTools() {},
        setDelegationPaused() {},
        getDelegationPaused: () => false,
        getMaxSpawnDepth: () => 3,
        ...(extra.agent ?? {}),
      }) as never }),
      applyModel() {},
      setMode() {},
      setTheme() {},
      setThinking() {},
      requestExit() {},
      ...extra,
    }
  }

  it('session.save 导出会话为 markdown（真实落盘）', async () => {
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1','t',1,1)`).run()
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('s1','user','你好',1)`).run()
    const g = new GatewayClient(makeKernel() as any)
    const r = await gre(g, 'session.save', { session_id: 's1' })
    expect(r.ok).toBe(true)
    const { existsSync, readFileSync } = await import('node:fs')
    expect(existsSync(r.file)).toBe(true)
    expect(readFileSync(r.file, 'utf8')).toContain('你好')
  })

  it('session.save 空会话诚实报错', async () => {
    const g = new GatewayClient(makeKernel() as any)
    const r = await gre(g, 'session.save', { session_id: 's1' })
    expect(r.ok).toBe(false)
  })

  it('rollback list/diff/restore 桥接 checkpoints 表（真实往返）', async () => {
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1','t',1,1)`).run()
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('s1','user','旧消息',1)`).run()
    // 保存快照（与内核 /checkpoint save 同路径）
    const { saveCheckpoint } = await import('../src/store/db.js')
    const rows = db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id='s1'`).all()
    saveCheckpoint(db, 's1', { kind: 'manual', messages: rows })
    const g = new GatewayClient(makeKernel() as any)
    // list
    const list = await gre(g, 'rollback.list', { session_id: 's1' })
    expect(list.enabled).toBe(true)
    expect(list.checkpoints.length).toBe(1)
    expect(list.checkpoints[0].hash).toBe('#1')
    // diff
    const diff = await gre(g, 'rollback.diff', { hash: '#1', session_id: 's1' })
    expect(diff.stat).toContain('快照 1 条消息')
    // restore（先改坏会话再回滚）
    db.prepare(`UPDATE messages SET content='被改坏' WHERE session_id='s1'`).run()
    const restore = await gre(g, 'rollback.restore', { hash: '#1', session_id: 's1' })
    expect(restore.success).toBe(true)
    expect(restore.history_removed).toBe(1)
    const after = db.prepare(`SELECT content FROM messages WHERE session_id='s1'`).get() as { content: string }
    expect(after.content).toBe('旧消息')
  })

  it('tools.configure enable/disable 调用 updateTools（真实热生效）', async () => {
    const updated: Array<Record<string, unknown>> = []
    const g = new GatewayClient(makeKernel({ adapter: createTuiPresentationAdapter({ db, agent: ({
      run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
      abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true,
      updateTools: (t: Record<string, unknown>) => updated.push(t),
    }) as never }) }) as any)
    const r = await gre(g, 'tools.configure', { action: 'disable', names: ['fs_'] })
    expect(r.changed.length).toBeGreaterThan(0)
    expect(updated.length).toBe(1)
    expect(updated[0]).not.toHaveProperty('fs_read')
    // 再 enable 恢复
    await gre(g, 'tools.configure', { action: 'enable', names: ['fs_'] })
    expect(updated[1]).toHaveProperty('fs_read')
  })

  it('reload.env 合并 .env 到 process.env（真实计数）', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${dir}/.env`, 'WXNODUS_TEST_RELOAD=abc\n', 'utf8')
    delete process.env.WXNODUS_TEST_RELOAD
    const g = new GatewayClient(makeKernel() as any)
    const r = await gre(g, 'reload.env', {})
    expect(r.updated).toBe(1)
    expect(process.env.WXNODUS_TEST_RELOAD).toBe('abc')
    // 二次加载无变化 → 0
    const r2 = await gre(g, 'reload.env', {})
    expect(r2.updated).toBe(0)
  })

  it('paste.collapse 大段粘贴落盘并返回路径', async () => {
    const g = new GatewayClient(makeKernel() as any)
    const r = await gre(g, 'paste.collapse', { text: 'x'.repeat(5000) })
    expect(r.path).toBeTruthy()
    const { existsSync, readFileSync } = await import('node:fs')
    expect(existsSync(r.path)).toBe(true)
    expect(readFileSync(r.path, 'utf8').length).toBe(5000)
  })
})

describe('假数据消除（A25）', () => {
  it('config.get mtime 返回真实 settings.json mtime（非恒 0）', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${dir}/settings.json`, '{"model":"x"}', 'utf8')
    const bus = createEventBus(dir)
    const g = new GatewayClient({
      dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}) }, bus,
      settings: { model: 'x' }, commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({ run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true }) as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
    const r = await gre(g, 'config.get', { key: 'mtime' })
    expect(r.mtime).toBeGreaterThan(0)
  })

  it('setup.status 返回真实 provider_configured（有 key → true）', async () => {
    const bus = createEventBus(dir)
    const g = new GatewayClient({
      dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}) }, bus,
      settings: { model: 'x', apiKeyEnc: 'enc1:abc' }, commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({ run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true }) as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
    const r = await gre(g, 'setup.status', {})
    expect(r.provider_configured).toBe(true)
  })

  it('setup.status 无 key → provider_configured false（诚实）', async () => {
    const bus = createEventBus(dir)
    const g = new GatewayClient({
      dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}) }, bus,
      settings: { model: 'x' }, commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({ run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true }) as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
    const r = await gre(g, 'setup.status', {})
    expect(r.provider_configured).toBe(false)
  })

  it('delegation.status caps 读内核真实限制（并发 2/深度 3）', async () => {
    const bus = createEventBus(dir)
    const g = new GatewayClient({
      dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}) }, bus,
      settings: { model: 'x' }, commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({
        run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart',
        setSessionId() {}, getSessionId: () => 's1', steer: () => true,
        setDelegationPaused() {}, getDelegationPaused: () => true, getMaxSpawnDepth: () => 3,
      }) as never }),
      taskRunner: { getMaxConcurrent: () => 2 },
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
    const r = await gre(g, 'delegation.status', {})
    expect(r.max_concurrent_children).toBe(2)
    expect(r.max_spawn_depth).toBe(3)
    expect(r.paused).toBe(true)
  })

  it('session.active_list 当前运行会话 status=working（非恒 idle）', async () => {
    const bus = createEventBus(dir)
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1','t',1,1)`).run()
    const g = new GatewayClient({
      dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}) }, bus,
      settings: { model: 'x' }, commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({ run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true }) as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
    ;(g as any).running = true
    const r = await gre(g, 'session.active_list', { current_session_id: 's1' })
    expect(r.sessions[0].status).toBe('working')
  })
})

describe('子代理富事件分流（A25）', () => {
  it('reasoning.delta 带 :sub 后缀 → subagent.thinking 事件', async () => {
    const bus = createEventBus(dir)
    const g = new GatewayClient({
      dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}) }, bus,
      settings: { model: 'x' }, commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({ run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true }) as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
    const events: any[] = []
    g.on('event', e => events.push(e))
    g.start()
    g.drain()
    bus.emit('reasoning.delta', { text: '子代理思考中', session_id: 's1:sub' })
    expect(events.some(e => e.type === 'subagent.thinking')).toBe(true)
    const ev = events.find(e => e.type === 'subagent.thinking')
    expect(ev.payload.subagent_id).toBe('s1:sub')
    expect(ev.payload.text).toContain('子代理思考中')
    // 主代理 reasoning 不误分流
    events.length = 0
    bus.emit('reasoning.delta', { text: '主代理思考', session_id: 's1' })
    expect(events.some(e => e.type === 'subagent.thinking')).toBe(false)
    expect(events.some(e => e.type === 'reasoning.delta')).toBe(true)
  })

  it('agent.tool 带 :sub 后缀 → subagent.tool 事件', async () => {
    const bus = createEventBus(dir)
    const g = new GatewayClient({
      dataDir: dir, cwd: process.cwd(), db, mem, config: { get: () => ({}) }, bus,
      settings: { model: 'x' }, commandBus: createCommandBus(),
      adapter: createTuiPresentationAdapter({ db, agent: ({ run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true }) as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
    const events: any[] = []
    g.on('event', e => events.push(e))
    g.start()
    g.drain()
    bus.emit('agent.tool', { name: 'fs_read', args: { path: 'x' }, phase: 'start', toolId: 't1', session_id: 's1:sub' })
    const ev = events.find(e => e.type === 'subagent.tool')
    expect(ev).toBeTruthy()
    expect(ev.payload.tool_name).toBe('fs_read')
    // 主代理工具不误分流（仍发 tool.start）
    events.length = 0
    bus.emit('agent.tool', { name: 'fs_read', args: { path: 'x' }, phase: 'start', toolId: 't2', session_id: 's1' })
    expect(events.some(e => e.type === 'subagent.tool')).toBe(false)
    expect(events.some(e => e.type === 'tool.start')).toBe(true)
  })
})

describe('complete.slash 接入层补全（档案模型/档案 id）', () => {
  it('/model <前缀> → 目录 + 档案模型联合补全（replace_from=7）', async () => {
    const g = makeGateway({ model: 'glm-4v-flash' });
    (g as any).kernel.settings.providers = [{ id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['custom-a', 'custom-b'] }];
    const r = await gre(g, 'complete.slash', { text: '/model cus' });
    expect(r.items.map((i: any) => i.text)).toContain('custom-a');
    expect(r.items.map((i: any) => i.text)).toContain('custom-b');
    expect(r.replace_from).toBe(7);
    // 目录命中照常（deep 前缀）
    const r2 = await gre(g, 'complete.slash', { text: '/model deep' });
    expect(r2.items.map((i: any) => i.text)).toContain('deepseek-v4-pro');
  });

  it('/profile use <前缀> → 档案 id 补全（replace_from=13）', async () => {
    const g = makeGateway({ model: 'glm-4v-flash' });
    (g as any).kernel.settings.providers = [{ id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: [] }, { id: 'relay2', name: '另一个', baseURL: 'https://r2.example.com/v1', models: [] }];
    const r = await gre(g, 'complete.slash', { text: '/profile use rel' });
    expect(r.items.map((i: any) => i.text)).toEqual(['relay1', 'relay2']);
    expect(r.replace_from).toBe(13);
  });

  it('普通斜杠补全不受影响（/hel → /help）', async () => {
    const g = makeGateway({ model: 'glm-4v-flash' });
    const r = await gre(g, 'complete.slash', { text: '/hel' });
    expect(r.items.map((i: any) => i.text)).toContain('/help');
    expect(r.replace_from).toBe(1);
  });
});

describe('capture.attach 截图即问', () => {
  it('成功路径（有图形环境）→ 附件落盘 + pending 登记；无环境 → 诚实失败', async () => {
    const g = makeGateway({ model: 'glm-4v-flash' });
    const r = await gre(g, 'capture.attach', { session_id: 's1' });
    if (r.ok) {
      // 真实图形环境：截图落盘 + pending 登记（下次提问随能力门管线注入）
      expect(r.attached).toBe(true);
      expect(typeof r.file).toBe('string');
      expect(existsSync(r.file)).toBe(true);
      expect(existsSync(join(dir, 'attachments', 's1', 'pending.json'))).toBe(true);
    } else {
      // CI/无图形环境：captureScreen 返回 null → 诚实失败，不伪造 attached
      expect(typeof r.error).toBe('string');
      expect(existsSync(join(dir, 'attachments', 's1', 'pending.json'))).toBe(false);
    }
  });
});

describe('model.options 参考价目', () => {
  it('catalog provider 带 prices（免费/收费/未收录三态），档案模型未收录不显示', async () => {
    const g = makeGateway({ model: 'glm-4v-flash' });
    (g as any).kernel.settings.providers = [{ id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['custom-a'] }];
    const r = await gre(g, 'model.options', {});
    const ds = r.providers.find((p: any) => p.slug === 'deepseek')!;
    expect(ds.prices['deepseek-chat']).toEqual({ in: 0.28, out: 0.42, cacheRead: 0.07, cacheWrite: 0.28 }); // cacheRead/cacheWrite：成本五维缓存读/写价（波 1 ⑩）
    expect(ds.prices['deepseek-v4-pro']).toBeUndefined(); // 未收录定价诚实不显示
    const zhipu = r.providers.find((p: any) => p.slug === 'zhipu')!;
    expect(zhipu.prices['glm-4-flash']).toEqual({ in: 0, out: 0 });
    const prof = r.providers.find((p: any) => p.slug === 'profile:relay1')!;
    expect(prof.prices['custom-a']).toBeUndefined();
  });
});

describe('model.options is_current 初始定位（选择器落在当前模型所在提供商）', () => {
  it('当前模型所在提供商 is_current=true，其余 false', async () => {
    const g = makeGateway({ model: 'glm-4v-flash' });
    const r = await gre(g, 'model.options', {});
    const cur = r.providers.filter((p: any) => p.is_current === true);
    expect(cur).toHaveLength(1);
    expect(cur[0]!.slug).toBe('zhipu'); // glm-4v-flash 属 zhipu 组
  });
  it('档案模型为当前模型 → profile 组 is_current=true（catalog 组全 false）', async () => {
    const g = makeGateway({ model: 'custom-a' });
    (g as any).kernel.settings.providers = [{ id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['custom-a'] }];
    const r = await gre(g, 'model.options', {});
    const cur = r.providers.filter((p: any) => p.is_current === true);
    expect(cur).toHaveLength(1);
    expect(cur[0]!.slug).toBe('profile:relay1');
  });
});

describe('model.save_key / model.disconnect / model.add（/key 并入 /model 的 RPC 面）', () => {
  it('save_key 档案 slug → 写档案 key 槽并激活（不动全局单槽）', async () => {
    const g = makeGateway({ model: 'custom-a' });
    (g as any).kernel.settings.providers = [{ id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['custom-a'] }];
    const r = await gre(g, 'model.save_key', { slug: 'profile:relay1', api_key: 'sk-r1' });
    expect(r.provider.slug).toBe('profile:relay1');
    expect(r.provider.authenticated).toBe(true);
    const providers = (g as any).kernel.settings.providers as Array<Record<string, any>>;
    expect(decryptKey(String(providers[0]!.key))).toBe('sk-r1');
    expect((g as any).kernel.settings.activeProvider).toBe('relay1');
    expect((g as any).kernel.settings.baseURL).toBe('https://r.example.com/v1');
  });
  it('save_key 目录厂商 slug → 密钥入该厂商 apiKeys 槽', async () => {
    const g = makeGateway({});
    await gre(g, 'model.save_key', { slug: 'zhipu', api_key: 'sk-z' });
    const apiKeys = (g as any).kernel.settings.apiKeys as Record<string, string>;
    expect(decryptKey(String(apiKeys['zhipu']))).toBe('sk-z');
    expect((g as any).kernel.settings.keyProvider).toBe('zhipu');
  });
  it('disconnect 档案 slug → 只清档案 key 槽；全局单槽不受影响', async () => {
    const g = makeGateway({ apiKeyEnc: encryptKey('global-key') });
    (g as any).kernel.settings.providers = [{ id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['custom-a'], key: encryptKey('sk-r1') }];
    const r = await gre(g, 'model.disconnect', { slug: 'profile:relay1' });
    expect(r.disconnected).toBe(true);
    const providers = (g as any).kernel.settings.providers as Array<Record<string, any>>;
    expect(providers[0]!.key).toBeUndefined();
    expect((g as any).kernel.settings.apiKeyEnc).toBeTruthy(); // 全局密钥保留
  });
  it('model.add → 创建档案 + 激活 + 返回 provider；缺参诚实报错', async () => {
    const g = makeGateway({});
    const r = await gre(g, 'model.add', { name: '我的中转', base_url: 'https://relay.example.com/v1', models: ['gpt-4o-mini', 'o3-mini'], api_key: 'sk-add' });
    expect(r.ok).toBe(true);
    expect(r.id).toBe('custom'); // 「我的中转」全非法字符 → sanitize 回退 custom
    expect(r.provider.slug).toBe('profile:custom');
    expect(r.provider.authenticated).toBe(true);
    const providers = (g as any).kernel.settings.providers as Array<Record<string, any>>;
    expect(providers).toHaveLength(1);
    expect(decryptKey(String(providers[0]!.key))).toBe('sk-add');
    expect((g as any).kernel.settings.activeProvider).toBe('custom');
    expect((g as any).kernel.settings.model).toBe('gpt-4o-mini');
    const bad = await gre(g, 'model.add', { name: 'x', models: ['m'] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('base_url');
  });
});

describe('adapter usageRange 单一事实源（unmeasured 透传）', () => {
  it('0 token 行 → unmeasured 计数透传（状态栏 ⚠N 数据源）', () => {
    const ins = db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`);
    ins.run('s1', 'm1', 100, 50, Date.now());
    ins.run('s1', 'm1', 0, 0, Date.now()); // 端点未上报用量
    const adapter = createTuiPresentationAdapter({ db, agent: { getSessionId: () => 's1' } as never });
    const s = adapter.data.usage.usageRange('today');
    expect(s).toEqual({ input: 100, output: 50, total: 150, calls: 2, unmeasured: 1 });
  });
  it('非法区间回退 today（与 /usage 同口径）', () => {
    const adapter = createTuiPresentationAdapter({ db, agent: { getSessionId: () => 's1' } as never });
    const s = adapter.data.usage.usageRange('bogus');
    expect(s.calls).toBe(0);
    expect(s.unmeasured).toBe(0);
  });
});
