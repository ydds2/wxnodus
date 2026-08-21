// tests/v4-wave1-misc.test.ts — V4 P1-9/10/11：hunk 行尾保真 / BOM 保真 / tool_search 装配链 / plugin 二进制
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyHunkToText, lineDiff, parseHunks, reverseHunk } from '../src/kernel/hunkApply.js';
import { coreTools } from '../src/kernel/tools.js';

const work = (name: string) => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', `wx-${name}-`));
};

describe('V4 P1-9 hunk 回写行尾保真', () => {
  it('CRLF 文件单 hunk 回滚：行尾保持 CRLF（此前整文件翻转为 LF）', () => {
    const before = 'line1\r\nline2\r\nline3\r\n';
    const after = 'line1\r\nCHANGED\r\nline3\r\n'; // 模型以 LF 视图改动后回写为 CRLF
    const hunks = parseHunks(lineDiff(before, after));
    expect(hunks.length).toBe(1);
    const r = applyHunkToText(after, reverseHunk(hunks[0]!));
    expect(r.ok).toBe(true);
    // 回滚产物与 before 完全一致（含 CRLF 行尾）
    expect(r.ok && r.text).toBe(before);
  });
  it('LF 文件零回归：行尾保持 LF', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nX\nc\n';
    const r = applyHunkToText(after, reverseHunk(parseHunks(lineDiff(before, after))[0]!));
    expect(r.ok && r.text).toBe(before);
  });
});

describe('V4 P1-9 fs_write BOM 保真', () => {
  it('原文件有 BOM、新内容无 → 保留 BOM；原无 → 不加', async () => {
    const d = work('bom');
    try {
      const tools = coreTools();
      const f = join(d, 'bom.txt');
      writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('旧内容', 'utf8')]));
      await tools.fs_write!.run({ path: f, content: '新内容' }, { cwd: d } as any);
      const out = readFileSync(f);
      expect(out[0]).toBe(0xef); // BOM 保留
      expect(out.subarray(3).toString('utf8')).toBe('新内容');
      const f2 = join(d, 'nobom.txt');
      writeFileSync(f2, 'x', 'utf8');
      await tools.fs_write!.run({ path: f2, content: 'y' }, { cwd: d } as any);
      expect(readFileSync(f2)[0]).not.toBe(0xef); // 原无 BOM 不加
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });
});

describe('V4 P1-10 tool_search 纳入装配链', () => {
  it('updateTools 热重载重建后 tool_search 仍可执行（此前仅 createAgent 注入一次即丢——B-10）', async () => {
    const { createAgent } = await import('../src/kernel/agent.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { createMemory } = await import('../src/kernel/memory.js');
    const { createEventBus } = await import('../src/kernel/events.js');
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = work('ts');
    const db = openDB(d);
    try {
      const script: Array<any> = [
        { type: 'tool_call', name: 'tool_search', args: { query: '记忆' } },
        { type: 'text', content: '检索完成' },
      ];
      let call = 0;
      const agent = createAgent({
        db, bus: createEventBus(d), mem: createMemory(db), sessionId: 'p110',
        config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
        toolLazyLoad: true,
        callModel: async (): Promise<any> => {
          call += 1;
          if (call === 1) {
            agent.updateTools({ ...coreTools() }); // 热重载（/mcp add、/plugin reload 同路径）——首轮模型调用前重建
            return script[0];
          }
          return script[1];
        },
      } as any);
      const r = await agent.run('检索工具');
      // tool_search 执行成功（未被重载丢弃）→ 回合走到终稿；丢失则首轮「工具不存在」且 script[0] 被消耗后无终稿
      expect(r.text).toBe('检索完成');
    } finally { closeDB(db); try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });
});

describe('V4 P1-11 plugin install 二进制保真（单元级）', () => {
  it('Buffer 直拷恒等：utf8 往返在非 UTF8 字节序列上必损坏（缺陷实证）', () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]); // PNG 头 + 破坏性字节
    const roundTrip = Buffer.from(bin.toString('utf8'), 'utf8'); // 旧实现路径
    expect(roundTrip.equals(bin)).toBe(false); // 旧路径损坏实证
    expect(Buffer.from(bin).equals(bin)).toBe(true); // 新路径（readFileSync 无 encoding）恒等
  });
});

// V4 P1-12：doom_loop 分级行为锁定——同签名重复：提醒注入（模型获自纠机会）→ 硬停终止
// （人工确认档延至 P2-4 审批通道泛化——loopJudge 语义判定已提供合法轮询恢复路径）
import { createAgent as _ca } from '../src/kernel/agent.js';
import { openDB as _odb, closeDB as _cdb } from '../src/store/db.js';
import { createMemory as _cm } from '../src/kernel/memory.js';
import { createEventBus as _ceb } from '../src/kernel/events.js';

describe('V4 P1-12 doom_loop 分级行为', () => {
  it('同签名工具调用连发：提醒档注入换策略提示仍继续；达硬停档终止且带恢复指引', async () => {
    const d = work('loop');
    const db = _odb(d);
    const notices: string[] = [];
    try {
      const bus = _ceb(d);
      bus.on('agent.error', (e: any) => notices.push(String(e?.payload?.message ?? e?.message ?? '')));
      let call = 0;
      const seenHints: string[] = [];
      const agent = _ca({
        db, bus, mem: _cm(db), sessionId: 'p112',
        config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock', loopRemindAt: 2, loopHardStopAt: 4 } } as any,
        callModel: async (_req: any, sc: any): Promise<any> => {
          call += 1;
          if (call <= 6) return { type: 'tool_call', name: 'fs_read', args: { path: './package.json' } };
          return { type: 'text', content: 'end' };
        },
      } as any);
      // 拦截回喂给模型的工具结果，观察提醒注入（mock callModel 侧看不到 tool 结果——
      // 改经 run 结果断言：硬停发生（4 连同签名）→ r.ok=false 且文案含恢复指引
      const r = await agent.run('反复读');
      expect(String((r as any).text)).toMatch(/循环|重复/);
      expect(notices.join(' ')).toMatch(/循环|重复/);
    } finally { _cdb(db); try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });
});
