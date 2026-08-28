// tests/regressions/known-failures/kf-002-config-full-unreachable.regression.test.ts — KF-002 迁移绿回归
// 契约：GatewayClient config.get({key:'full'}) 返回完整配置快照（绝不 undefined 包装）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createCommandBus } from '../../../src/app/CommandBus.js';
import { GatewayClient } from '../../../src/wxnodus-ui/wxGateway.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-kf-002-')); tempDirs.push(d); return d; };

describe('KF-002 resolved: config.get full 可达', () => {
  it("key='full' 返回完整配置快照（settings + 运行环境）", async () => {
    const dir = tmp();
    const db = openDB(dir);
    try {
      const settings = { model: 'glm-4v-flash', theme: 'wxnodus' };
      const kernel = {
        dataDir: dir, cwd: process.cwd(), db,
        mem: createMemory(db),
        config: { get: () => settings, getKey: (p: string, k: string) => (settings as any)[k] },
        bus: createEventBus(dir), settings, commandBus: createCommandBus(),
        agent: { run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }), abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, getSessionId: () => 's1', steer: () => true },
        applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
      };
      const gw = new GatewayClient(kernel as never);
      const r: any = await gw.request('config.get', { key: 'full' });
      expect(r && (r.full || r.settings || typeof r.value === 'object')).toBeTruthy();
      expect(r.full.model).toBe('glm-4v-flash');
      expect(r.full.theme).toBe('wxnodus');
      expect(r.full.dataDir).toBe(dir);
    } finally { closeDB(db); }
  });
});
