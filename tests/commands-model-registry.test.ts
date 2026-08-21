// tests/commands-model-registry.test.ts — /model add|set-key 共享注册表（开放兼容：任意 OpenAI 兼容端点）
import { describe, it, expect } from 'vitest';
import { parseModelAddArgs, sanitizeProfileId, addCustomModel, applyModelKey } from '../src/kernel/modelRegistry.js';
import { decryptKey } from '../src/kernel/providers.js';

/** 内存版配置端口（模拟 ConfigStore getKey/setKey） */
const makeCfg = (init: Record<string, unknown> = {}) => {
  const s: Record<string, unknown> = { ...init };
  return {
    cfg: {
      getKey: (p: string, k: string) => (p === 'settings' ? s[k] : undefined),
      setKey: (p: string, k: string, v: unknown) => { if (p === 'settings') s[k] = v; },
    },
    s,
  };
};

describe('parseModelAddArgs 纯函数', () => {
  it('完整解析：位置模型ID（逗号分隔）+ --base/--name/--key', () => {
    const r = parseModelAddArgs(['gpt-4o-mini,o3-mini', '--base', 'https://relay.example.com/v1', '--name', '我的中转', '--key', 'sk-test']);
    expect(r).not.toBeNull();
    expect(r!.modelIds).toEqual(['gpt-4o-mini', 'o3-mini']);
    expect(r!.baseURL).toBe('https://relay.example.com/v1');
    expect(r!.name).toBe('我的中转');
    expect(r!.key).toBe('sk-test');
  });
  it('--name 缺省取第一个模型 ID；模型去重', () => {
    const r = parseModelAddArgs(['a,a,b', '--base', 'https://x/v1']);
    expect(r!.name).toBe('a');
    expect(r!.modelIds).toEqual(['a', 'b']);
  });
  it('缺模型或缺 http(s) base → null（诚实拒绝）', () => {
    expect(parseModelAddArgs(['a', '--base', 'ftp://x'])).toBeNull();
    expect(parseModelAddArgs(['--base', 'https://x/v1'])).toBeNull();
    expect(parseModelAddArgs([])).toBeNull();
  });
});

describe('sanitizeProfileId', () => {
  it('非法字符替换为 -；全非法回退 custom；超长截断', () => {
    expect(sanitizeProfileId('My Relay 1')).toBe('my-relay-1');
    expect(sanitizeProfileId('我的中转站')).toBe('custom');
    expect(sanitizeProfileId('a'.repeat(60))).toHaveLength(40);
  });
});

describe('addCustomModel 档案写入', () => {
  it('创建档案 + 激活 + baseURL/model 同步 + 密钥加密 + 审计', () => {
    const { cfg, s } = makeCfg();
    const events: string[] = [];
    const r = addCustomModel(cfg, { modelIds: ['m1', 'm2'], baseURL: 'https://relay/v1', name: 'Relay', key: 'sk-secret' }, (ev) => events.push(ev));
    expect(r.id).toBe('relay');
    const providers = s['providers'] as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]!.name).toBe('Relay');
    expect(decryptKey(String(providers[0]!.key))).toBe('sk-secret');
    expect(s['activeProvider']).toBe('relay');
    expect(s['baseURL']).toBe('https://relay/v1');
    expect(s['model']).toBe('m1');
    expect(events).toEqual(['model.add']);
    expect(r.message).toContain('已添加自定义接口');
  });
  it('同名档案 id 自动去重（relay → relay-2）', () => {
    const { cfg, s } = makeCfg({ providers: [{ id: 'relay', name: '旧', baseURL: 'https://old', models: ['x'] }] });
    const r = addCustomModel(cfg, { modelIds: ['m1'], baseURL: 'https://new', name: 'Relay' });
    expect(r.id).toBe('relay-2');
    expect((s['providers'] as Array<Record<string, unknown>>)).toHaveLength(2);
  });
});

describe('applyModelKey 密钥写入（原 /key set 迁入）', () => {
  it('profileId 指定档案：写档案 key 槽并激活（密钥与端点配对）', () => {
    const { cfg, s } = makeCfg({ providers: [{ id: 'relay1', name: '中转', baseURL: 'https://r/v1', models: ['custom-a'] }] });
    const msg = applyModelKey(cfg, 'sk-r1', { profileId: 'relay1' });
    expect(msg).toContain('档案 relay1');
    const p = (s['providers'] as Array<Record<string, unknown>>)[0]!;
    expect(decryptKey(String(p.key))).toBe('sk-r1');
    expect(s['activeProvider']).toBe('relay1');
    expect(s['baseURL']).toBe('https://r/v1');
    expect(s['model']).toBe('custom-a'); // 缺省补档案第一个模型
  });
  it('档案不存在 → 诚实报错不落盘', () => {
    const { cfg } = makeCfg();
    expect(applyModelKey(cfg, 'sk-x', { profileId: 'ghost' })).toContain('档案不存在');
  });
  it('无选项：按当前 baseURL 归属写 apiKeys 槽 + 遗留单槽 + 归属标注 + 默认补齐', () => {
    const { cfg, s } = makeCfg();
    const msg = applyModelKey(cfg, 'sk-ds');
    expect(msg).toContain('provider=');
    const apiKeys = s['apiKeys'] as Record<string, string>;
    expect(Object.values(apiKeys).every(e => decryptKey(e) === 'sk-ds')).toBe(true);
    expect(decryptKey(String(s['apiKeyEnc']))).toBe('sk-ds');
    expect(s['keyProvider']).toBeTruthy();
    expect(s['model']).toBeTruthy();
    expect(s['baseURL']).toContain('http');
  });
  it('provider 指定目录厂商：密钥落入该厂商槽（选择器 key 段用）', () => {
    const { cfg, s } = makeCfg({ baseURL: 'https://api.deepseek.com/v1' });
    applyModelKey(cfg, 'sk-z', { provider: 'zhipu' });
    const apiKeys = s['apiKeys'] as Record<string, string>;
    expect(decryptKey(String(apiKeys['zhipu']))).toBe('sk-z');
    expect(s['keyProvider']).toBe('zhipu');
  });
});

// V4 P4-6（W-5 品类痛点 15）：会话中切模型 → 缓存前缀失效——切换点统一附注
describe('模型切换缓存提示（P4-6）', () => {
  it('addCustomModel 自动切换消息含缓存失效提示', () => {
    const s: Record<string, unknown> = {};
    const cfg = {
      get: () => s,
      getKey: (_p: string, k: string) => s[k],
      setKey: (_p: string, k: string, v: unknown) => { s[k] = v },
    } as any;
    const r = addCustomModel(cfg, { modelIds: ['m1'], baseURL: 'https://relay/v1', name: 'R' });
    expect(r.message).toContain('缓存前缀失效');
    expect(r.message).toContain('首次响应会变慢');
  });
  it('/model 目录命中切换输出含缓存失效提示（handler 接线）', async () => {
    const { createCommandBus } = await import('../src/app/CommandBus.js');
    const { registerCoreHandlers } = await import('../src/commands/handlers.js');
    const setCalls: Array<[string, string]> = [];
    const ctx = {
      dataDir: process.cwd(),
      cwd: process.cwd(),
      db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
      config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined },
      setModel: (m: string, b: string) => { setCalls.push([m, b]) },
      openModelPicker: () => {},
    } as any;
    const bus = createCommandBus();
    registerCoreHandlers(bus, ctx);
    const r = await bus.execute('/model deepseek-chat');
    expect(r.ok).toBe(true);
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]![0]).toBe('deepseek-chat');
    expect(r.output).toContain('已切换模型');
    expect(r.output).toContain('缓存前缀失效');
  });
});
