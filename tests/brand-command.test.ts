// tests/brand-command.test.ts — /brand 命令（「独立艺术品」包装层写入口——2026-08-29 接线）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/app/CommandBus.js';
import { registerCoreHandlers } from '../src/commands/handlers.js';
import { registerExtHandlers } from '../src/commands/handlersExt.js';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wx-brand-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function harness(configService: any) {
  const d = tmp();
  const bus = createCommandBus();
  const ctx: any = {
    dataDir: d, cwd: process.cwd(),
    config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined },
    configService,
  };
  registerCoreHandlers(bus, ctx);
  registerExtHandlers(bus, ctx);
  return { bus, d };
}

describe('/brand 品牌化命令（「独一无二」包装层）', () => {
  it('set → show 往返（图标可选）', async () => {
    let stored: any = null;
    const { bus } = harness({
      setBranding: async (_scope: string, b: any) => { stored = b; return { ok: true }; },
      resolveBranding: async () => ({ ok: true, value: stored ? { name: stored.name, icon: stored.icon ?? null } : { name: 'wxnodus', icon: null } }),
    });
    const r = await bus.execute('/brand set 我的助手 ⚡');
    expect(r.ok).toBe(true);
    expect(String(r.output)).toContain('我的助手');
    expect(stored).toEqual({ name: '我的助手', icon: '⚡' });
    const shown = await bus.execute('/brand show');
    expect(String(shown.output)).toContain('⚡ 我的助手');
    const reset = await bus.execute('/brand reset');
    expect(String(reset.output)).toContain('已重置');
  });

  it('服务端校验拒绝 → 诚实失败提示（不假装成功）', async () => {
    const { bus } = harness({
      setBranding: async () => ({ ok: false }),
      resolveBranding: async () => ({ ok: true, value: { name: 'wxnodus', icon: null } }),
    });
    const r = await bus.execute('/brand set 非法名xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(String(r.output)).toContain('品牌设置失败');
  });

  it('服务未接入（headless）→ 诚实降级提示', async () => {
    const { bus } = harness(undefined);
    const r = await bus.execute('/brand show');
    expect(String(r.output)).toContain('未接入');
  });
});
