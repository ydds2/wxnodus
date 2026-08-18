// tests/supremacy-45.test.ts — ④ 子代理分型 + 结构化输出、⑤ 工具 schema 规范排序（2026-08-18）
// 覆盖：分型解析/只读白名单收敛/未知回退、delegate kind 参数透传、buildChatRequest response_format、
// llmSpec 请求带 json_object、toolsToOpenAI 插入顺序无关的字节稳定（caching 深化）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSubagentDef, SUBAGENT_KINDS, READONLY_SUBAGENT_TOOLS } from '../src/kernel/subagentTypes.js';
import { buildChatRequest } from '../src/kernel/providers.js';
import { toolsToOpenAI, coreTools } from '../src/kernel/tools.js';

describe('子代理分型（supremacy ④）', () => {
  it('三型齐备：explore/coder/review；只读型白名单无写能力', () => {
    expect(SUBAGENT_KINDS).toEqual(['explore', 'coder', 'review']);
    const exp = resolveSubagentDef('explore')!;
    expect(exp.systemPrompt).toContain('绝不修改');
    expect(exp.tools).toEqual([...READONLY_SUBAGENT_TOOLS]);
    expect(exp.tools).not.toContain('fs_write');
    expect(exp.tools).not.toContain('bash');
    const rev = resolveSubagentDef('REVIEW')!; // 大小写宽容
    expect(rev.label).toBe('审查');
    expect(rev.tools).not.toContain('apply_patch');
    const coder = resolveSubagentDef('coder')!;
    expect(coder.tools).toBeUndefined(); // 编码型走默认全工具面
  });
  it('未知/空 kind → null（调用方回退默认只读子代理，零漂移）', () => {
    expect(resolveSubagentDef('hacker')).toBeNull();
    expect(resolveSubagentDef('')).toBeNull();
    expect(resolveSubagentDef(undefined)).toBeNull();
  });
});

describe('结构化输出 response_format（supremacy ④）', () => {
  it('buildChatRequest：responseFormat 设置时请求体携带 json_object；缺省不携带（零漂移）', () => {
    const withRf = buildChatRequest({ baseURL: 'https://x/v1', model: 'm', key: 'k', messages: [{ role: 'user', content: 'hi' }], stream: false, responseFormat: 'json_object' });
    const body = JSON.parse(withRf.body);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const without = buildChatRequest({ baseURL: 'https://x/v1', model: 'm', key: 'k', messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(JSON.parse(without.body).response_format).toBeUndefined();
  });
  it('llmSpec 请求带 responseFormat json_object（结构化规格生成）', async () => {
    const { aiMakeSpec } = await import('../src/build/llmSpec.js');
    let captured: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      captured = init.body;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"title":"待办","summary":"x","scaffold":"web","acceptance":["可用"]}' } }] }) } as any;
    }));
    const r = await aiMakeSpec('做个待办', { baseURL: 'https://x/v1', model: 'm', key: 'k' });
    expect(r).not.toBeNull();
    expect(captured).toContain('"response_format":{"type":"json_object"}');
    expect(r!.title).toBe('待办');
    vi.unstubAllGlobals();
  });
});

describe('工具 schema 规范排序（supremacy ⑤ API 级 caching）', () => {
  it('插入顺序无关：不同装配顺序产出字节完全一致', () => {
    const all = coreTools();
    const forward = toolsToOpenAI(all);
    // 逆序重建对象（模拟不同合并/装配顺序）
    const reversed: Record<string, any> = {};
    for (const k of Object.keys(all).reverse()) reversed[k] = (all as any)[k];
    const backward = toolsToOpenAI(reversed);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
    // 且本身按名称升序（字节稳定契约）
    const names = forward.map(t => (t as any).function.name);
    expect([...names].sort()).toEqual(names);
  });
});
