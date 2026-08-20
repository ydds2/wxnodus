// tests/regressions/known-failures/kf-001-offline-precheck.regression.test.ts — KF-001 迁移绿回归
// 契约：无 key 但离线模型已就绪时，defaultCallModel 必须走本地 LLM 通道
// （离线优先——数据不出机、模型可不出机），绝不输出密钥配置引导（/key set）。
// 行为断言：伪造模型就绪标记（.onnx 占位），agent.run 文本不含密钥引导。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';
import { offlineModelId } from '../../../src/kernel/offlineModel.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } } });

const KEY_GUIDANCE = /请用 \/key set|未配置模型密钥/;

describe('KF-001 resolved: 离线模型就绪时无 key 也不输出密钥引导', () => {
  it('offline: 模型就绪 + apiKeyEnc null → 文本不含 /key set 引导（走本地通道）', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'kf-001-reg-'));
    tempDirs.push(fixtureDir);
    const model = 'offline:Qwen2.5-1.5B';
    const hfId = offlineModelId(model)!;
    // 伪造「离线模型已下载」事实（isOfflineModelReady 只看 models/<hfId> 下有 .onnx）
    mkdirSync(join(fixtureDir, 'models', ...hfId.split('/')), { recursive: true });
    writeFileSync(join(fixtureDir, 'models', ...hfId.split('/'), 'fake.onnx'), 'x');
    const prevDataDir = process.env.WXNODUS_DATA_DIR;
    process.env.WXNODUS_DATA_DIR = fixtureDir;
    const db = openDB(fixtureDir);
    try {
      const bus = createEventBus(fixtureDir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-001-reg',
        config: { settings: { apiKeyEnc: null, model } },
      });
      const r = await agent.run('你好');
      // 离线通道失败会如实报模型加载错误——但绝不出密钥配置引导
      expect(KEY_GUIDANCE.test(r.text)).toBe(false);
      expect(r.text.length).toBeGreaterThan(0);
    } finally {
      closeDB(db);
      if (prevDataDir === undefined) delete process.env.WXNODUS_DATA_DIR;
      else process.env.WXNODUS_DATA_DIR = prevDataDir;
    }
  }, 30000);

  it('源锚点：defaultCallModel 在无 key 引导之前先做 offline 预检（isOfflineModelReady）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/agent.ts'), 'utf8');
    const fn = src.slice(src.indexOf('const defaultCallModel'), src.indexOf('const key = keyRes.key'));
    expect(fn).toContain('isOfflineModelReady');
    // 预检先于密钥引导文本出现
    expect(fn.indexOf('isOfflineModelReady')).toBeLessThan(fn.indexOf('当前未配置模型密钥'));
  });
});
