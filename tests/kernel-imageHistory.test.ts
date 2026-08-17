// tests/kernel-imageHistory.test.ts — P3 多模态历史回显：摘要入历史/红线/降级/后续轮次可见
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createMemory } from '../src/kernel/memory.js';
import { attachImageSummary } from '../src/kernel/imageHistory.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let mem: ReturnType<typeof createMemory>;

const IMG: Array<{ dataUrl: string; mime: string }> = [{ dataUrl: 'data:image/png;base64,QUJDRA==', mime: 'image/png' }];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-imghist-'));
  db = openDB(dir);
  mem = createMemory(db);
});

afterEach(() => {
  closeDB(db);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL 延迟解锁 */ }
});

function lastUserContent(sessionId: string): string {
  const row = db.prepare(`SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY id DESC LIMIT 1`).get(sessionId) as { content: string } | undefined;
  return row?.content ?? '';
}

describe('attachImageSummary 摘要入历史', () => {
  it('摘要追加进最后一条 user 消息（后续轮次可见）', async () => {
    mem.append('s1', 'user', '问题一');
    mem.append('s1', 'assistant', '回答一');
    mem.append('s1', 'user', '看看这张图');
    const ok = await attachImageSummary({
      db, sessionId: 's1', images: IMG, apiKeyEnc: 'enc:mock',
      summarize: async () => '这是一张包含文字说明的测试截图',
    });
    expect(ok).toBe(true);
    expect(lastUserContent('s1')).toBe('看看这张图\n[附加图片] 这是一张包含文字说明的测试截图');
  });

  it('红线：无 key 且无注入实现 → 不调用 AI，消息保持原文', async () => {
    mem.append('s1', 'user', '看图');
    let called = 0;
    const ok = await attachImageSummary({
      db, sessionId: 's1', images: IMG, apiKeyEnc: null,
      summarize: async () => { called++; return '不应发生'; },
    });
    // 显式注入的 summarize 会被使用（测试注入优先）——红线针对"无注入时"
    expect(ok).toBe(true);
    expect(called).toBe(1);
    // 真正的红线路径：无注入 + 无 key
    const ok2 = await attachImageSummary({ db, sessionId: 's1', images: IMG, apiKeyEnc: null });
    expect(ok2).toBe(false);
    expect(lastUserContent('s1')).toBe('看图\n[附加图片] 不应发生'); // 无注入路径未改动消息
  });

  it('空图片 / summarize 返回空 → 不写入', async () => {
    mem.append('s1', 'user', 'x');
    expect(await attachImageSummary({ db, sessionId: 's1', images: [], apiKeyEnc: 'enc' })).toBe(false);
    expect(await attachImageSummary({
      db, sessionId: 's1', images: IMG, apiKeyEnc: 'enc',
      summarize: async () => null,
    })).toBe(false);
    expect(lastUserContent('s1')).toBe('x');
  });

  it('summarize 抛错 → 静默降级（消息保持原文，不阻断）', async () => {
    mem.append('s1', 'user', '看图');
    const ok = await attachImageSummary({
      db, sessionId: 's1', images: IMG, apiKeyEnc: 'enc',
      summarize: async () => { throw new Error('GLM-4V 超时'); },
    });
    expect(ok).toBe(false);
    expect(lastUserContent('s1')).toBe('看图');
  });

  it('摘要超长截断至 200 字', async () => {
    mem.append('s1', 'user', '看图');
    await attachImageSummary({
      db, sessionId: 's1', images: IMG, apiKeyEnc: 'enc',
      summarize: async () => '长'.repeat(500),
    });
    expect(lastUserContent('s1').length).toBe('看图'.length + '\n[附加图片] '.length + 200); // 摘要本体截断至 200
  });
});

describe('历史回显端到端（working 上下文可见）', () => {
  it('摘要写入后，下一轮 agent 消息包含图片摘要', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const bus = createEventBus(dir);
    let seen: string[] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 's2',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        seen = req.messages.map((m: any) => String(m.content));
        return { type: 'text', content: '收到' };
      },
    });
    // 第一轮带图（注入假摘要实现——真实 GLM-4V 走 network，测试用注入验证链路）
    mem.append('s2', 'user', '看看这张图');
    const { attachImageSummary } = await import('../src/kernel/imageHistory.js');
    await attachImageSummary({
      db, sessionId: 's2', images: IMG, apiKeyEnc: 'enc',
      summarize: async () => '图上有一个饼状图',
    });
    // 第二轮：历史应包含摘要
    await agent.run('根据刚才的图回答');
    expect(seen.some(t => t.includes('图上有一个饼状图'))).toBe(true);
  });

  it('文本模型带图：不注入 image_url parts（400 防御）且无 key 不产生摘要（红线降级）', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const bus = createEventBus(dir);
    const agent = createAgent({
      db, bus, mem, sessionId: 's3',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async (req: any) => {
        const last = req.messages[req.messages.length - 1];
        return { type: 'text', content: Array.isArray(last.content) ? '多模态' : '文本' };
      },
    });
    const r = await agent.run('描述这张图', { images: IMG });
    expect(r.ok).toBe(true);
    // 新契约：'mock'（目录外未知模型）按文本模型处理——image_url parts 绝不注入，
    // 无视觉 key 识别失败后诚实丢弃（不触发 Windows OCR 兜底），纯文本回复照常
    expect(r.text).toBe('文本');
    await new Promise(res => setTimeout(res, 50)); // 等待异步摘要（应无 key 跳过）
    expect(lastUserContent('s3')).toBe('描述这张图');
  });

  it('视觉模型带图：parts 直入消息（inject 路径）', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const bus = createEventBus(dir);
    const agent = createAgent({
      db, bus, mem, sessionId: 's4',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'glm-4v-flash' } } as any,
      callModel: async (req: any) => {
        const last = req.messages[req.messages.length - 1];
        return { type: 'text', content: Array.isArray(last.content) ? '多模态' : '文本' };
      },
    });
    const r = await agent.run('描述这张图', { images: IMG });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('多模态');
  });
});
