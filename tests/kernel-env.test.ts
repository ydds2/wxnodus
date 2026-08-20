// tests/kernel-env.test.ts — 子进程环境净化：白名单/密钥剥离/显式 extra
import { describe, it, expect, afterEach } from 'vitest';
import { sanitizedEnv } from '../src/kernel/env.js';

const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved[''] = undefined;
});

describe('sanitizedEnv 环境净化', () => {
  it('密钥类变量（KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL）一律剥离', () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    process.env.MY_SECRET = 's3cret';
    process.env.AUTH_TOKEN = 'tok';
    process.env.DBPASSWORD = 'pw';
    process.env.PATH = process.env.PATH ?? '';
    const out = sanitizedEnv();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.MY_SECRET).toBeUndefined();
    expect(out.AUTH_TOKEN).toBeUndefined();
    expect(out.DBPASSWORD).toBeUndefined();
  });
  it('core 环境与 WXNODUS_ 前缀保留；npm_/NODE_ 噪声剔除', () => {
    process.env.PATH = 'C:/bin';
    process.env.WXNODUS_HOOK_EVENT = 'stop';
    process.env.npm_config_registry = 'https://registry.npmjs.org';
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    const out = sanitizedEnv();
    expect(out.PATH).toBe('C:/bin');
    expect(out.WXNODUS_HOOK_EVENT).toBe('stop');
    expect(out.npm_config_registry).toBeUndefined();
    expect(out.NODE_OPTIONS).toBeUndefined();
  });
  it('显式 extra 强制传入（MCP cfg.env / hook 上下文）', () => {
    process.env.SECRET_KEY = 'x';
    const out = sanitizedEnv({ SECRET_KEY: 'explicit', WXNODUS_HOOK_DATA: '{}' });
    expect(out.SECRET_KEY).toBe('explicit'); // 用户显式声明 > 剥离策略
    expect(out.WXNODUS_HOOK_DATA).toBe('{}');
  });
});

describe('WXNODUS_ 命名空间内密钥过滤（安全审计修复）', () => {
  it('WXNODUS_API_KEY / WXNODUS_<厂商>_KEY 不透传子进程', () => {
    process.env.WXNODUS_API_KEY = 'sk-test';
    process.env.WXNODUS_DEEPSEEK_KEY = 'ds-test';
    process.env.WXNODUS_MODEL = 'kimi-k3'; // 非密钥 WXNODUS_ 变量仍透传
    const out = sanitizedEnv();
    expect(out.WXNODUS_API_KEY).toBeUndefined();
    expect(out.WXNODUS_DEEPSEEK_KEY).toBeUndefined();
    expect(out.WXNODUS_MODEL).toBe('kimi-k3');
  });
});
