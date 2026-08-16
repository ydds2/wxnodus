import { describe, it, expect } from 'vitest';
import { parseProfileAddArgs, parseBalanceSetArgs } from '../src/commands/handlersExt.js';

describe('profile/balance 参数解析', () => {
  it('parseProfileAddArgs: 名称+baseURL 必填，--models 逗号拆分', () => {
    // 档案 id 需 ASCII（供 WXNODUS_<ID>_KEY 环境变量名使用）
    expect(parseProfileAddArgs(['relay1', 'https://r.example.com/v1', '--models', 'a,b,c']))
      .toEqual({ name: 'relay1', baseURL: 'https://r.example.com/v1', models: ['a', 'b', 'c'] });
    expect(parseProfileAddArgs(['中转'])).toBeNull();
    expect(parseProfileAddArgs(['bad name!', 'https://r.example.com'])).toBeNull();
    expect(parseProfileAddArgs(['ok', 'not-a-url'])).toBeNull();
  });
  it('parseBalanceSetArgs: url 可选 --path', () => {
    expect(parseBalanceSetArgs(['https://r.example.com/balance', '--path', 'data.balance']))
      .toEqual({ url: 'https://r.example.com/balance', jsonPath: 'data.balance' });
    expect(parseBalanceSetArgs(['--path', 'data.balance']))
      .toEqual({ url: '', jsonPath: 'data.balance' });
    expect(parseBalanceSetArgs([])).toEqual({ url: '', jsonPath: '' });
  });
});
