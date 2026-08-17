import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProfileAddArgs, parseBalanceSetArgs } from '../src/commands/handlersExt.js';
import { registerCoreHandlers } from '../src/commands/handlers.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });

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

describe('/model 档案模型直达（接入层 UI 闭环）', () => {
  it('档案模型命中 → 切 activeProvider + baseURL；未命中列表含档案模型', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-prof-'));
    dirs.push(d);
    const db = openDB(d);
    const settings: Record<string, any> = {
      providers: [{ id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['custom-a', 'custom-b'] }],
      activeProvider: '',
    };
    const calls: Array<{ model: string; baseURL: string }> = [];
    const ctx = {
      dataDir: d,
      cwd: process.cwd(),
      db,
      mem: createMemory(db),
      bus: createEventBus(d),
      config: {
        get: () => settings,
        getKey: (_s: string, k: string) => settings[k],
        setKey: (_s: string, k: string, v: unknown) => { settings[k] = v; },
      },
      agent: { getSessionId: () => 's1' },
      setModel: (model: string, baseURL: string) => { calls.push({ model, baseURL }); },
      openModelPicker: () => {},
    } as any;
    const bus = createCommandBus();
    registerCoreHandlers(bus, ctx as never);
    try {
      const r = await bus.execute('/model custom-a');
      expect(r.ok).toBe(true);
      expect(String(r.output)).toContain('档案 relay1');
      expect(settings.activeProvider).toBe('relay1');
      expect(calls).toEqual([{ model: 'custom-a', baseURL: 'https://r.example.com/v1' }]);
      // 未命中：目录列表应含档案模型（供选择）
      const miss = await bus.execute('/model nope-model');
      expect(String(miss.output)).toContain('custom-a（档案 relay1');
      expect(String(miss.output)).toContain('custom-b（档案 relay1');
    } finally {
      closeDB(db);
    }
  });
});
