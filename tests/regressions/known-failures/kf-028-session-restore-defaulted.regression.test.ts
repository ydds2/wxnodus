// tests/regressions/known-failures/kf-028-session-restore-defaulted.regression.test.ts — KF-028 迁移绿回归
// 契约：恢复会话后 Gateway/UI 必须绑定恢复的 sessionId（经 agent.getSessionId），不得回落 default。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/cli/index.ts'), 'utf8');

describe('KF-028 resolved: 会话恢复绑定真实 sessionId', () => {
  const resumeBlock = (): string => {
    const s = src();
    // 取最后一次 pickResumeSession 出现（即调用点）之后的恢复块（split[1] 会截在 import 与调用之间）
    return s.slice(s.lastIndexOf('pickResumeSession'));
  };

  it('pickResumeSession 之后的恢复块经 getSessionId 绑定（不回落 default）', () => {
    expect(resumeBlock()).toMatch(/getSessionId/);
  });

  it('恢复块 setSessionId 与绑定读取成对出现', () => {
    expect(resumeBlock()).toMatch(/setSessionId\(resumeId\)/);
    expect(resumeBlock()).toMatch(/agent\.getSessionId\(\)/);
  });
});
