import { describe, it, expect } from 'vitest';
import { resolveProviderProfile, defaultModelForProfile, resolveModelForChat, type ProviderProfile } from '../src/kernel/profiles.js';

const enc = 'enc1:deadbeef:deadbeef:deadbeef'; // 占位（解密不在本测）

describe('profiles', () => {
  it('resolveProviderProfile: providers 数组命中 activeProvider', () => {
    const p: ProviderProfile = { id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['gpt-4o-mini'], key: enc, balanceUrl: '', balancePath: '' };
    const s = { activeProvider: 'relay1', providers: [p], baseURL: 'https://api.deepseek.com/v1' };
    const r = resolveProviderProfile(s);
    expect(r?.profile.id).toBe('relay1');
    expect(r?.source).toBe('providers');
  });

  it('resolveProviderProfile: 无档案时按 baseURL 回退 catalog 档案', () => {
    const s = { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    const r = resolveProviderProfile(s);
    expect(r?.source).toBe('catalog');
    expect(r?.profile.balanceUrl).toBe('https://api.deepseek.com/user/balance');
  });

  it('resolveModelForChat: catalog 外模型名不被强制回退', () => {
    const s = { model: 'my-custom-relay-model', baseURL: 'https://r.example.com/v1' };
    expect(resolveModelForChat(s)).toBe('my-custom-relay-model');
  });

  it('resolveModelForChat: 模型名为空回退档案默认', () => {
    const p: ProviderProfile = { id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['gpt-4o-mini'] };
    expect(resolveModelForChat({ model: '', activeProvider: 'relay1', providers: [p] })).toBe('gpt-4o-mini');
  });
});
