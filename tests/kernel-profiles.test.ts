import { describe, it, expect } from 'vitest';
import { resolveProviderProfile, defaultModelForProfile, resolveModelForChat, profileHealth, type ProviderProfile } from '../src/kernel/profiles.js';

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


describe('profileHealth 档案一致性', () => {
  it('健康档案零问题', () => {
    const issues = profileHealth(
      [{ id: 'a', name: 'A', baseURL: 'https://a.example.com/v1', models: ['m1'] }],
      'a'
    );
    expect(issues).toEqual([]);
  });

  it('activeProvider 指向不存在 → active-missing', () => {
    const issues = profileHealth(
      [{ id: 'a', name: 'A', baseURL: 'https://a.example.com/v1', models: [] }],
      'ghost'
    );
    expect(issues.map(i => i.kind)).toEqual(['active-missing']);
  });

  it('重复 id / 缺 id / baseURL 非 http(s) 全部识别', () => {
    const issues = profileHealth(
      [
        { id: 'a', name: 'A', baseURL: 'https://a.example.com/v1' },
        { id: 'a', name: 'A2', baseURL: 'https://a2.example.com/v1' },
        { id: '', name: '无id', baseURL: 'https://x.example.com' },
        { id: 'b', name: 'B', baseURL: 'ftp://bad' },
      ],
      'a'
    );
    expect(issues.map(i => i.kind)).toEqual(['duplicate-id', 'duplicate-id', 'bad-base-url']);
  });

  it('空/未配置档案零问题（无 active 悬空误报）', () => {
    expect(profileHealth([], '')).toEqual([]);
    expect(profileHealth(undefined, 'x')).toEqual([]);
    expect(profileHealth([], 'ghost')).toEqual([]);
  });
});
