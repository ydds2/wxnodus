// tests/kernel-sessionImport.test.ts — V4 P4-4：会话互操作（竞品 JSONL 嗅探 + Markdown 渲染）
// 夹具按各家真实结构手工构造（机制参考 kimi /import-from-cc-codex；结构特征来自
// claude projects JSONL / codex rollout JSONL 的公开格式，不含任何竞品代码/文案）。
import { describe, it, expect } from 'vitest';
import { parseExternalSessionJsonl, renderSessionMarkdown } from '../src/kernel/sessionImport.js';

// Claude Code ~/.claude/projects/<proj>/<uuid>.jsonl 行结构
const claudeJsonl = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我做一个待办系统' }, timestamp: '2026-08-20T10:00:00.000Z' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的，我先分析需求' }] }, timestamp: '2026-08-20T10:00:05.000Z' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu1', name: 'fs_edit', input: { path: 'todo.js', content: '...' } },
    { type: 'text', text: '已写入 todo.js' },
  ] }, timestamp: '2026-08-20T10:00:10.000Z' }),
].join('\n');

// Codex ~/.codex/sessions/<date>/rollout-*.jsonl 行结构（response_item 包 payload）
const codexJsonl = [
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查这个仓库的测试' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '共 42 个测试文件' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }), // 非消息行——跳过
].join('\n');

// Codex 早期形态：直接 type=message
const codexLegacyJsonl = [
  JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧版格式' }] }),
  JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '识别成功' }] }),
].join('\n');

// wxnodus /export --jsonl 输出
const wxnodusJsonl = [
  JSON.stringify({ id: 1, role: 'user', content: '你好', tool_call_id: null, archived: 0, ts: 1700000000000, session_id: 's1' }),
  JSON.stringify({ id: 2, role: 'assistant', content: '你好，有什么可以帮你', tool_call_id: null, archived: 0, ts: 1700000001000, session_id: 's1' }),
].join('\n');

describe('parseExternalSessionJsonl 嗅探', () => {
  it('Claude Code 格式：kind=claude + parts 文本化（text 原样/tool_use 摘要）', () => {
    const r = parseExternalSessionJsonl(claudeJsonl);
    expect(r.kind).toBe('claude');
    expect(r.messages.length).toBe(3);
    expect(r.messages[0]).toMatchObject({ role: 'user', content: '帮我做一个待办系统' });
    expect(r.messages[1]!.content).toContain('好的，我先分析需求');
    const toolMsg = r.messages[2]!.content;
    expect(toolMsg).toContain('[工具调用 fs_edit]');
    expect(toolMsg).toContain('已写入 todo.js');
    // timestamp ISO 字符串 → 数值 ts
    expect(r.messages[0]!.ts).toBe(Date.parse('2026-08-20T10:00:00.000Z'));
  });

  it('Claude content 为纯字符串时直接取值', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '字符串内容' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
    ].join('\n');
    const r = parseExternalSessionJsonl(text);
    expect(r.kind).toBe('claude');
    expect(r.messages[0]!.content).toBe('字符串内容');
  });

  it('Codex response_item 格式：kind=codex + 非消息行（function_call）跳过', () => {
    const r = parseExternalSessionJsonl(codexJsonl);
    expect(r.kind).toBe('codex');
    expect(r.messages.length).toBe(2);
    expect(r.messages[0]!.content).toBe('检查这个仓库的测试');
    expect(r.messages[1]!.role).toBe('assistant');
  });

  it('Codex 早期直接 message 格式也可识别', () => {
    const r = parseExternalSessionJsonl(codexLegacyJsonl);
    expect(r.kind).toBe('codex');
    expect(r.messages.length).toBe(2);
  });

  it('wxnodus 自有格式：kind=wxnodus + ts 保留', () => {
    const r = parseExternalSessionJsonl(wxnodusJsonl);
    expect(r.kind).toBe('wxnodus');
    expect(r.messages.length).toBe(2);
    expect(r.messages[0]).toMatchObject({ role: 'user', content: '你好', ts: 1700000000000 });
  });

  it('非会话 JSONL（单行/普通结构）→ unknown 空消息（调用方兜底）', () => {
    expect(parseExternalSessionJsonl('{"a":1}\n{"a":2}').kind).toBe('unknown');
    expect(parseExternalSessionJsonl('{"a":1}').kind).toBe('unknown');
    expect(parseExternalSessionJsonl('纯文本\n第二行').kind).toBe('unknown');
  });

  it('坏行容忍：夹杂损坏行不影响其余行解析', () => {
    const dirty = claudeJsonl + '\n{ 坏行';
    const r = parseExternalSessionJsonl(dirty);
    expect(r.kind).toBe('claude');
    expect(r.messages.length).toBe(3);
  });
});

describe('renderSessionMarkdown', () => {
  it('角色标题 + 内容 + 时间 + 尾注计数', () => {
    const md = renderSessionMarkdown('s1', [
      { role: 'user', content: '帮我做待办', ts: 1700000000000 },
      { role: 'assistant', content: '已完成', tool_call_id: 'tc1', ts: 1700000001000 },
    ], { title: '待办系统' });
    expect(md).toContain('# 会话 s1：待办系统');
    expect(md).toContain('## 👤 用户');
    expect(md).toContain('帮我做待办');
    expect(md).toContain('## 🤖 助手');
    expect(md).toContain('> 工具调用消息'); // tool_call_id 折叠标注
    expect(md).toMatch(/共 2 条消息/);
  });

  it('未知角色原样显示；ts 缺省不输出时间', () => {
    const md = renderSessionMarkdown('s2', [{ role: 'tool', content: 'x' }]);
    expect(md).toContain('## tool');
    expect(md).not.toMatch(/ · \d{4}-\d{2}/);
  });
});
