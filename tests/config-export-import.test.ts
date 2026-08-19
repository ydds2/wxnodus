// tests/config-export-import.test.ts — F1/F2 修复契约：/config export|import 二次注册遮蔽合并后真实可达；
// 分级键与分发对齐（/webhook remove 危险、/acp server 危险、/skill install 落基准 confirm）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandBus } from '../src/app/CommandBus.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';
import { classifyCommand } from '../src/kernel/commandLevels.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const makeBus = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-cfg-'));
  dirs.push(d);
  const db = openDB(d);
  const settings: Record<string, any> = { model: 'deepseek-chat', apiKeyEnc: 'enc:secret123', theme: 'dark' };
  const ctx = {
    db,
    bus: createEventBus(d),
    mem: createMemory(db),
    cwd: d,
    dataDir: d,
    config: {
      get: () => settings,
      setKey: (_s: string, key: string, value: any) => { settings[key] = value; },
      getKey: (_s: string, key: string) => settings[key],
    },
  } as any;
  const bus = createCommandBus();
  registerExtHandlers(bus, ctx);
  return { bus, settings, close: () => closeDB(db) };
};

describe('F1：/config export|import 真实可达（遮蔽合并修复契约）', () => {
  it('/config export 返回 settings JSON；--redact 剥离密钥且不改内存态', async () => {
    const { bus, settings } = makeBus();
    const r = await bus.execute('/config export');
    expect(r.ok).toBe(true);
    const j = JSON.parse(r.output);
    expect(j.settings.model).toBe('deepseek-chat');
    expect(j.settings.apiKeyEnc).toBe('enc:secret123');
    const r2 = await bus.execute('/config export --redact');
    const j2 = JSON.parse(r2.output);
    expect(j2.settings.apiKeyEnc).toBeUndefined();
    expect(settings.apiKeyEnc).toBe('enc:secret123');
  });

  it('/config import <文件> 合并入 settings；文件缺失诚实报错', async () => {
    const { bus, settings } = makeBus();
    const f = join(tmpdir(), `wx-cfg-imp-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ settings: { bashOutputCap: 8000, model: 'glm-4-flash' } }), 'utf8');
    const r = await bus.execute(`/config import ${f}`);
    expect(r.ok).toBe(true);
    expect(settings.bashOutputCap).toBe(8000);
    expect(settings.model).toBe('glm-4-flash');
    const miss = await bus.execute(`/config import ${f}.nope`);
    expect(miss.ok).toBe(true);
    expect(String(miss.output)).toContain('文件不存在');
    rmSync(f, { force: true });
  });

  it('F2：分级键与分发对齐', () => {
    expect(classifyCommand('/webhook remove https://x')).toBe('danger');
    expect(classifyCommand('/acp server')).toBe('danger');
    expect(classifyCommand('/skill install x')).toBe('confirm'); // 无 install 分发——落基准键
    expect(classifyCommand('/config import f.json')).toBe('confirm');
    expect(classifyCommand('/config export')).toBe('safe');
  });
});
