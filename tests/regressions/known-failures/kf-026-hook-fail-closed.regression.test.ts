// tests/regressions/known-failures/kf-026-hook-fail-closed.regression.test.ts — KF-026 正式回归
// 安全关键 hook（preToolUse）崩溃/超时/非零退出/畸形输出必须 fail-closed（拦截工具）；
// 只有干净退出 0 且无 DENY 输出才放行。KF-026 case 已退役，本文件是唯一权威回归。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../../../src/kernel/events.js';
import { createHookRunner } from '../../../src/kernel/hooks.js';
import { decideSecurityHook } from '../../../src/domain/hooks/hookDecision.js';

function runnerWith(cmd: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-kf-026-regression-'));
  const runner = createHookRunner(() => ({ hooks: { preToolUse: cmd } }), createEventBus(dir));
  return { dir, runner };
}

describe('KF-026 security hook fail-closed regression', () => {
  it('blocks the tool when the hook process crashes with a non-zero exit and no output', async () => {
    const { dir, runner } = runnerWith('node -e "process.exit(1)"');
    try {
      expect(await runner.preToolUse('fs_write', { path: 'x' })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks the tool when the hook crashes with a non-zero exit even with stray output', async () => {
    const { dir, runner } = runnerWith('node -e "console.log(\'partial\');process.exit(2)"');
    try {
      expect(await runner.preToolUse('fs_write', { path: 'x' })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks the tool on an explicit DENY line from a clean hook exit', async () => {
    const { dir, runner } = runnerWith('node -e "console.log(\'DENY: policy forbids this\')"');
    try {
      expect(await runner.preToolUse('fs_write', { path: 'x' })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the tool only on a clean zero exit without DENY', async () => {
    const { dir, runner } = runnerWith('node -e "console.log(\'allow\')"');
    try {
      expect(await runner.preToolUse('fs_write', { path: 'x' })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies timeout as a deny decision', () => {
    expect(decideSecurityHook({ kind: 'timeout' })).toMatchObject({ allow: false, code: 'HOOK_TIMEOUT' });
    expect(decideSecurityHook({ kind: 'missing' })).toMatchObject({ allow: false, code: 'HOOK_EXECUTION_FAILED' });
    expect(decideSecurityHook({ kind: 'error', message: 'x' })).toMatchObject({ allow: false, code: 'HOOK_EXECUTION_FAILED' });
    expect(decideSecurityHook({ kind: 'exited-nonzero', output: '' })).toMatchObject({ allow: false, code: 'HOOK_MALFORMED' });
    expect(decideSecurityHook({ kind: 'ok', output: 'allow' })).toMatchObject({ allow: true });
    expect(decideSecurityHook({ kind: 'ok', output: 'DENY: no' })).toMatchObject({ allow: false });
  });
});
