import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent } from '../../../src/kernel/agent.js';
import { offlineModelId } from '../../../src/kernel/offlineModel.js';

await runKnownFailureCase({
  failureId: 'KF-001',
  expectedFailureCode: 'OFFLINE_PROVIDER_KEY_PRECHECK',
  assertionMessage: 'OFFLINE_PROVIDER_KEY_PRECHECK',
  run: async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'wxn-kf-001-'));
    const model = 'offline:Qwen2.5-1.5B';
    const hfId = offlineModelId(model)!;
    // 伪造「离线模型已下载」事实（isOfflineModelReady 只看 <dataDir>/models/<hfId> 下有 .onnx）
    mkdirSync(join(fixtureDir, 'models', ...hfId.split('/')), { recursive: true });
    writeFileSync(join(fixtureDir, 'models', ...hfId.split('/'), 'fake.onnx'), 'x');
    process.env.WXNODUS_DATA_DIR = fixtureDir;
    const db = openDB(fixtureDir);
    try {
      const bus = createEventBus(fixtureDir);
      const mem = createMemory(db);
      const agent = createAgent({
        db, bus, mem, sessionId: 'kf-001',
        config: { settings: { apiKeyEnc: null, model } },
      });
      const r = await agent.run('你好');
      // 正确行为：无 key 但离线模型就绪 → 走离线通道，不返回密钥配置引导
      const isKeyGuidance = /请用 \/key set|未配置模型密钥/.test(r.text);
      assert.equal(isKeyGuidance, false, 'OFFLINE_PROVIDER_KEY_PRECHECK');
    } finally {
      closeDB(db);
      delete process.env.WXNODUS_DATA_DIR;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
});
