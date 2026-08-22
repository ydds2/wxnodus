// tests/kernel-historyNormalize.test.ts — D（kimi normalize_history 机制对齐）：发送前合并相邻同角色消息
// 纯函数四性质：确定性 / 幂等 / 协议安全（tool 与带 tool_calls 的 assistant 绝不合并）/ 字节稳定
import { describe, it, expect } from 'vitest';
import { mergeAdjacentMessages } from '../src/kernel/historyNormalize.js';

describe('历史归一化（D）', () => {
  it('相邻 user+user 字符串合并为单条（\\n 连接）', () => {
    const out = mergeAdjacentMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '第一问' },
      { role: 'user', content: '第二问' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe('user');
    expect(out[1]!.content).toBe('第一问\n第二问');
  });

  it('相邻 system+system 合并；user/system 相邻不合并', () => {
    const out = mergeAdjacentMessages([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'U' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toBe('A\nB');
    expect(out[1]!.role).toBe('user');
  });

  it('tool 消息与带 tool_calls 的 assistant 绝不合并（OpenAI 配对唯一性）', () => {
    const msgs = [
      { role: 'tool', content: 'r1', tool_call_id: 'c1' },
      { role: 'tool', content: 'r2', tool_call_id: 'c2' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'y', arguments: '{}' } }] },
    ];
    const out = mergeAdjacentMessages(msgs as any);
    expect(out).toHaveLength(4); // 一条不合并
    expect(out[0]!.tool_call_id).toBe('c1');
  });

  it('异型 content（字符串×parts）统一转 parts 拼接', () => {
    const out = mergeAdjacentMessages([
      { role: 'user', content: '文本' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] },
    ]);
    expect(out).toHaveLength(1);
    const parts = out[0]!.content as Array<Record<string, any>>;
    expect(parts[0]).toEqual({ type: 'text', text: '文本' });
    expect(parts[1]!.type).toBe('image_url');
  });

  it('幂等且字节稳定：合并两次 = 合并一次（前缀缓存前提）', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'c' },
    ];
    const once = mergeAdjacentMessages(msgs);
    const twice = mergeAdjacentMessages(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // 前缀稳定性：尾部追加新相邻消息只改写尾元素（合并语义使然——旧前缀除尾外字节不变）
    const grown = mergeAdjacentMessages([...msgs, { role: 'user', content: 'd' }]);
    expect(grown).toHaveLength(once.length); // 追加的相邻消息并入尾元素，不增长
    expect(JSON.stringify(grown.slice(0, -1))).toBe(JSON.stringify(once.slice(0, -1)));
    const tail = grown[grown.length - 1]!.content as string;
    expect(tail.startsWith('c')).toBe(true);
    expect(tail.endsWith('d')).toBe(true);
    expect(tail.length).toBe(3); // 'c' + 换行 + 'd'
  });

  it('不修改原数组（发送层浅拷贝语义）', () => {
    const msgs = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
    mergeAdjacentMessages(msgs);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe('a');
  });
});
