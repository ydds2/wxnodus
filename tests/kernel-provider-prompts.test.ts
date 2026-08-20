// tests/kernel-provider-prompts.test.ts — supremacy 1.1 分族提示词：provider 解析 + systemPrompt 注入契约
// 覆盖：providerPromptFor 已知/未知 provider、resolveProviderForPrompt 目录优先/baseURL 探测回退、
// buildSystemPrompt 注入位置（persona 之后）与零漂移（未提供/空串不注入）
import { describe, it, expect } from 'vitest';
import { providerPromptFor, resolveProviderForPrompt } from '../src/kernel/providerPrompts.js';
import { buildSystemPrompt } from '../src/kernel/systemPrompt.js';

describe('providerPromptFor（分族提示段）', () => {
  it('已知 provider 返回专属段（deepseek/kimi/zhipu）', () => {
    expect(providerPromptFor('deepseek')?.label).toBe('DeepSeek');
    expect(providerPromptFor('deepseek')?.body).toContain('reasoning_content');
    expect(providerPromptFor('kimi')?.label).toBe('Kimi');
    expect(providerPromptFor('kimi')?.body).toContain('highspeed');
    expect(providerPromptFor('zhipu')?.label).toBe('GLM');
    expect(providerPromptFor('zhipu')?.body).toContain('GLM-4V');
  });
  it('未知 provider → null（走通用提示，不注入）', () => {
    expect(providerPromptFor('openai-compatible')).toBeNull();
    expect(providerPromptFor('unknown-x')).toBeNull();
  });
});

describe('resolveProviderForPrompt（模型/端点 → provider）', () => {
  it('目录 modelId 命中优先（即使 baseURL 相悖）', () => {
    expect(resolveProviderForPrompt('deepseek-v4-pro', 'https://api.moonshot.cn/v1')).toBe('deepseek');
    expect(resolveProviderForPrompt('kimi-k3', undefined)).toBe('kimi');
    expect(resolveProviderForPrompt('glm-4.5', 'https://api.deepseek.com/v1')).toBe('zhipu');
  });
  it('目录未命中 → baseURL 探测回退；均未命中 → openai-compatible', () => {
    expect(resolveProviderForPrompt('my-finetune', 'https://api.deepseek.com/v1')).toBe('deepseek');
    expect(resolveProviderForPrompt(undefined, 'https://api.moonshot.cn/v1')).toBe('kimi');
    expect(resolveProviderForPrompt('x', 'https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu');
    expect(resolveProviderForPrompt('x', 'https://example.com/v1')).toBe('openai-compatible');
    expect(resolveProviderForPrompt(undefined, undefined)).toBe('openai-compatible');
  });
});

describe('buildSystemPrompt 注入契约（supremacy 1.1）', () => {
  const base = {
    mode: 'smart' as const,
    cwd: 'C:\\proj',
    model: 'deepseek-v4-pro',
    hasImageIn: false,
    now: new Date('2026-08-18T00:00:00'),
  };
  it('providerPrompt 段出现在 persona 之后（前缀结构不破坏）', () => {
    const s = buildSystemPrompt({
      ...base,
      persona: '你是一个严谨工程师',
      providerPrompt: providerPromptFor('deepseek')!.body,
    });
    expect(s).toContain('【DeepSeek 专属提示】');
    const personaAt = s.indexOf('你是一个严谨工程师');
    expect(personaAt).toBeGreaterThan(-1);
    expect(s.indexOf('【DeepSeek 专属提示】')).toBeGreaterThan(personaAt);
  });
  it('未提供 providerPrompt → 输出不含该段（零漂移）', () => {
    const s = buildSystemPrompt(base);
    expect(s).not.toContain('【DeepSeek 专属提示】');
    expect(s).not.toContain('reasoning_content');
  });
  it('空白 providerPrompt → 不注入', () => {
    const s = buildSystemPrompt({ ...base, providerPrompt: '   ' });
    expect(s).not.toContain('【');
  });
});
