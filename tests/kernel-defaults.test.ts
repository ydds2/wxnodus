// tests/kernel-defaults.test.ts — 默认值单一事实源：settings > env > 内置默认
import { describe, it, expect } from 'vitest';
import { resolveDefaultModel, resolveDefaultBaseURL, FALLBACK_MODEL, FALLBACK_BASE_URL } from '../src/kernel/defaults.js';

describe('默认模型/端点解析（开放兼容：切换不改代码）', () => {
  it('无配置无 env → 内置默认', () => {
    expect(resolveDefaultModel({}, {})).toBe(FALLBACK_MODEL);
    expect(resolveDefaultBaseURL({}, {})).toBe(FALLBACK_BASE_URL);
  });
  it('env 覆盖内置默认（WXNODUS_MODEL / WXNODUS_BASE_URL）', () => {
    const env = { WXNODUS_MODEL: 'my-model', WXNODUS_BASE_URL: 'https://my-gateway.example/v1' };
    expect(resolveDefaultModel({}, env)).toBe('my-model');
    expect(resolveDefaultBaseURL({}, env)).toBe('https://my-gateway.example/v1');
  });
  it('settings 优先于 env（用户显式设置最高优先级）', () => {
    const env = { WXNODUS_MODEL: 'env-model', WXNODUS_BASE_URL: 'https://env.example/v1' };
    expect(resolveDefaultModel({ model: 'cfg-model' }, env)).toBe('cfg-model');
    expect(resolveDefaultBaseURL({ baseURL: 'https://cfg.example/v1' }, env)).toBe('https://cfg.example/v1');
  });
  it('空字符串视为未设置（trim 过滤）', () => {
    expect(resolveDefaultModel({}, { WXNODUS_MODEL: '  ' })).toBe(FALLBACK_MODEL);
    expect(resolveDefaultModel({ model: '  ' })).toBe(FALLBACK_MODEL);
  });
});

describe('resolveApiKey（per-provider env 优先）', async () => {
  const { resolveApiKey, encryptKey } = await import('../src/kernel/providers.js');
  it('WXNODUS_<PROVIDER>_KEY 按 baseURL 推断生效（deepseek/kimi/zhipu）', () => {
    const env = { WXNODUS_DEEPSEEK_KEY: 'ds-key', WXNODUS_KIMI_KEY: 'kimi-key' };
    expect(resolveApiKey({ baseURL: 'https://api.deepseek.com/v1' }, env).key).toBe('ds-key');
    expect(resolveApiKey({ baseURL: 'https://api.moonshot.cn/v1' }, env).key).toBe('kimi-key');
    expect(resolveApiKey({ baseURL: 'https://api.deepseek.com/v1' }, env).source).toBe('env');
  });
  it('WXNODUS_API_KEY 通用 env 兜底（openai-compatible 端点）', () => {
    const env = { WXNODUS_API_KEY: 'generic-key' };
    expect(resolveApiKey({ baseURL: 'https://my-gateway.example/v1' }, env).key).toBe('generic-key');
  });
  it('env 优先于 apiKeyEnc 槽位', () => {
    const env = { WXNODUS_API_KEY: 'env-key' };
    const r = resolveApiKey({ baseURL: 'https://api.deepseek.com/v1', apiKeyEnc: encryptKey('enc-key') }, env);
    expect(r.key).toBe('env-key');
    expect(r.source).toBe('env');
  });
  it('无 env 时解密 apiKeyEnc 槽位；解密失败标记 error', () => {
    const enc = encryptKey('secret-abc');
    const r = resolveApiKey({ baseURL: 'https://api.deepseek.com/v1', apiKeyEnc: enc });
    expect(r.key).toBe('secret-abc');
    expect(r.source).toBe('enc');
    const bad = resolveApiKey({ baseURL: 'https://api.deepseek.com/v1', apiKeyEnc: 'enc1:bad:bad:bad' });
    expect(bad.key).toBeNull();
    expect(bad.error).toBe('decrypt-failed');
  });
  it('无任何配置 → none', () => {
    const r = resolveApiKey({}, {});
    expect(r.key).toBeNull();
    expect(r.source).toBe('none');
  });
});
