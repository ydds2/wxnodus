// tests/regressions/known-failures/kf-021-gate-exit-code.regression.test.ts — KF-021 已修复回归
// 测试门真实执行 npm test 并把非零退出传播为 pass=false。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from '../../../src/build/gate.js';

describe('KF-021 resolved: gate propagates npm test exit code', () => {
  it('npm test 非零退出 → 测试门失败且 pass=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf021-'));
    try {
      mkdirSync(join(dir, 'server'), { recursive: true });
      writeFileSync(join(dir, 'server', 'index.js'), 'console.log("x")\n');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(1)"' } }));
      const r = await runGate({ projectDir: dir, dataDir: dir });
      const testGate = r.gates.find(g => /测试/.test(g.name));
      expect(testGate).toBeDefined();
      expect(testGate!.ok).toBe(false);
      expect(r.pass).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
