import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

await runKnownFailureCase({
  failureId: 'KF-027',
  expectedFailureCode: 'WIRE_REGISTERED_BEFORE_READY',
  assertionMessage: 'WIRE_REGISTERED_BEFORE_READY',
  run: async () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/cli/index.ts'), 'utf8');
    const start = src.indexOf('if (opts.wire) {');
    const wireBlock = start >= 0 ? src.slice(start, src.indexOf('process.exit(0)', start)) : '';
    // 正确行为：wire stdin 处理器必须在 gateway ready 之后才接受 RPC 帧
    assert.ok(/ready|gateway\.start/.test(wireBlock), 'WIRE_REGISTERED_BEFORE_READY');
  },
});
