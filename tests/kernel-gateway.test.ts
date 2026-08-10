// tests/kernel-gateway.test.ts — P3：session.undo 响应契约（UI 死路径修复）+ 软归档语义
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '../src/wxnodus-ui/wxGateway.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createMemory } from '../src/kernel/memory.js';
import { createEventBus } from '../src/kernel/events.js';
import { createCommandBus } from '../src/app/CommandBus.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let mem: ReturnType<typeof createMemory>;
let gw: GatewayClient;
let runCalls: Array<{ text: string; opts: any }>;

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
  const kernel = {
    dataDir: dir,
    cwd: process.cwd(),
    db,
    mem,
    config: { get: () => ({}), getKey: () => undefined },
    bus,
    settings: { model: 'glm-4v-flash', ...settings },
    commandBus: createCommandBus(),
    agent,
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
    const r = await gw.request('session.undo', { session_id: 's1' });
    expect(r.ok).toBe(false);
    expect(r.removed).toBe(0);
  });

  it('撤销一轮返回 removed=2（user+assistant）且软归档', async () => {
    mem.append('s1', 'user', '问题一');
    mem.append('s1', 'assistant', '回答一');
    mem.append('s1', 'user', '问题二');
    mem.append('s1', 'assistant', '回答二');
    const r = await gw.request('session.undo', { session_id: 's1' });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(2);
    // 软归档：消息仍在库中（黑洞 recall 保留），仅 archived=1
    const archived = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='s1' AND archived=1`).get() as any;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id='s1'`).get() as any;
    expect(archived.c).toBe(2);
    expect(total.c).toBe(4);
    // 视图回退：loadMessages 过滤归档 → 只剩第一轮
    const act = await gw.request('session.activate', { session_id: 's1' });
    const view = (act.messages as Array<{ role: string; text: string }>).filter(m => m.role !== 'system');
    expect(view.map(m => m.text)).toEqual(['问题一', '回答一']);
  });

  it('撤销前生成 checkpoint 快照（可恢复）', async () => {
    mem.append('s1', 'user', '问题');
    mem.append('s1', 'assistant', '回答');
    await gw.request('session.undo', { session_id: 's1' });
    const cp = db.prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE session_id='s1'`).get() as any;
    expect(cp.c).toBeGreaterThan(0);
  });

  it('连续撤销直至空（removed 归零不报错）', async () => {
    mem.append('s1', 'user', '唯一问题');
    mem.append('s1', 'assistant', '唯一回答');
    const r1 = await gw.request('session.undo', { session_id: 's1' });
    expect(r1.removed).toBe(2);
    const r2 = await gw.request('session.undo', { session_id: 's1' });
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
    const r = await gw.request('image.attach', { session_id: 's1', path: img });
    expect(r.attached).toBe(true);
    expect(r.width).toBe(256);
    expect(r.height).toBe(128);
    expect(r.token_estimate).toBe(Math.ceil((256 * 128) / 750));
    // 附件已复制进会话附件目录
    expect(existsSync(join(dir, 'attachments', 's1', 'pending.json'))).toBe(true);
  });

  it('不存在的路径 / 非图片文件 → attached:false', async () => {
    const r1 = await gw.request('image.attach', { session_id: 's1', path: join(dir, 'ghost.png') });
    expect(r1.attached).toBe(false);
    const txt = join(dir, 'not-image.txt');
    writeFileSync(txt, '纯文本不是图片');
    const r2 = await gw.request('image.attach', { session_id: 's1', path: txt });
    expect(r2.attached).toBe(false);
  });

  it('图像模型：pending 随 prompt.submit 注入（多模态 parts）', async () => {
    const img = join(dir, 'attach.png');
    writePng(img, 320, 200);
    await gw.request('image.attach', { session_id: 's1', path: img });
    await gw.request('prompt.submit', { session_id: 's1', text: '看看这张图' });
    await new Promise(r => setTimeout(r, 20));
    expect(runCalls.length).toBe(1);
    const opts = runCalls[0]!.opts;
    expect(opts?.images?.length).toBe(1);
    expect(String(opts.images[0].dataUrl).startsWith('data:image/png;base64,')).toBe(true);
    // pending 已消费
    expect(existsSync(join(dir, 'attachments', 's1', 'pending.json'))).toBe(false);
  });

  it('文本模型：优雅降级（不注入 + system.notice 提示）', async () => {
    gw = makeGateway({ model: 'deepseek-v4-flash' });
    (gw as any).subscribed = true // 激活事件直发（否则 publish 缓冲）
    const img = join(dir, 'attach2.png');
    writePng(img, 100, 100);
    await gw.request('image.attach', { session_id: 's1', path: img });
    const notices: string[] = [];
    (gw as any).on('event', (e: any) => { if (e?.type === 'notification.show') notices.push(String(e?.payload?.text ?? '')); });
    await gw.request('prompt.submit', { session_id: 's1', text: '看图说话' });
    await new Promise(r => setTimeout(r, 20));
    expect(runCalls[0]?.opts).toBeUndefined(); // 无 images 参数
    expect(notices.some(t => t.includes('GLM-4V Flash'))).toBe(true);
  });

  it('clipboard.paste 响应形态稳定（有图/无图均返回合法结构）', async () => {
    const r = await gw.request('clipboard.paste', { session_id: 's1' });
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
    const s1 = await gw.request('spawn_tree.save', {
      finished_at: Date.now() / 1000,
      label: '第一个委派',
      session_id: 's1',
      started_at: Date.now() / 1000 - 30,
      subagents: [{ goal: '目标A', status: 'completed' }],
    });
    expect(s1.ok).toBe(true);
    // 另一会话的快照（不应出现在 s1 列表）
    await gw.request('spawn_tree.save', {
      finished_at: Date.now() / 1000,
      label: '其他会话委派',
      session_id: 's-other',
      subagents: [{ goal: 'B', status: 'running' }, { goal: 'C', status: 'completed' }],
    });
    const list = await gw.request('spawn_tree.list', { session_id: 's1', limit: 10 });
    expect(list.entries.length).toBe(1);
    expect(list.entries[0].label).toBe('第一个委派');
    expect(list.entries[0].count).toBe(1);
    // load 回放
    const loaded = await gw.request('spawn_tree.load', { path: list.entries[0].path });
    expect(loaded.subagents.length).toBe(1);
    expect(loaded.subagents[0].goal).toBe('目标A');
    expect(loaded.session_id).toBe('s1');
  });
  it('空目录 / 损坏文件容错', async () => {
    const empty = await gw.request('spawn_tree.list', { session_id: 'ghost' });
    expect(empty.entries).toEqual([]);
    const bad = await gw.request('spawn_tree.load', { path: join(dir, '不存在.json') });
    expect(bad.subagents).toEqual([]);
  });
});
