import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WavWriter } from '../../../src/kernel/voice.js';

await runKnownFailureCase({
  failureId: 'KF-005',
  expectedFailureCode: 'VOICE_WAV_HEADER_CORRUPT',
  assertionMessage: 'VOICE_WAV_HEADER_CORRUPT',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-005-'));
    try {
      const p = join(dir, 'rec.wav');
      const w = new WavWriter(p, 16000, 1);
      w.write(Buffer.alloc(100, 0x55));
      w.finalize();
      const bytes = readFileSync(p);
      // 正确行为：RIFF 头保持 'WAVE'/'fmt ' 标识；当前 finalize 从偏移 4 写 8 字节覆盖头部
      assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WAVE', 'VOICE_WAV_HEADER_CORRUPT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
