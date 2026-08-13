import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopAndTranscribe } from '../../../src/kernel/voice.js';

await runKnownFailureCase({
  failureId: 'KF-006',
  expectedFailureCode: 'WHISPER_EVENT_LOOP_BLOCKED',
  assertionMessage: 'WHISPER_EVENT_LOOP_BLOCKED',
  run: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-006-'));
    try {
      const wavPath = join(dir, 'rec.wav');
      writeFileSync(wavPath, 'RIFFxxxx');
      // 伪造 whisper 可执行文件：node.exe 副本（收到 -m 等未知选项快速退出，但走 spawnSync 同步通道）
      const fakeBin = join(dir, 'whisper-fake.exe');
      copyFileSync(process.execPath, fakeBin);
      const rec: any = { proc: { pid: -1, kill() {} }, wavPath };
      const t0 = Date.now();
      let timerMs = -1;
      setTimeout(() => { timerMs = Date.now() - t0; }, 10);
      await stopAndTranscribe(rec, dir, { voice: { whisperBin: fakeBin, modelPath: 'x' } }, process.env);
      // 正确行为：转写子进程异步执行，10ms 定时器应在子进程退出前触发（≈10ms）
      assert.ok(timerMs !== -1 && timerMs <= 20, 'WHISPER_EVENT_LOOP_BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
