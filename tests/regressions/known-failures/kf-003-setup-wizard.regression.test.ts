// tests/regressions/known-failures/kf-003-setup-wizard.regression.test.ts — KF-003 迁移绿回归
// 契约：首次安装必须进入 zh/en 引导（R13 bootstrap）——setupWizard 是唯一向导入口，
// 真实决策：首跑 TTY → onboarding-required + 持久化；已有 locale → continue（绝不假引导）。
import { describe, expect, it, vi } from 'vitest';
import { runSetupWizard } from '../../../src/bootstrap/setupWizard.js';

describe('KF-003 resolved: 首次安装进入真实 zh/en 引导', () => {
  it('向导入口模块存在且首跑 TTY 进入 onboarding-required 并持久化 locale', async () => {
    const persist = vi.fn(async () => {});
    const decision = await runSetupWizard({
      argv: [],
      env: {},
      isTTY: true,
      systemLocale: 'zh-CN',
      readWorkspaceLocale: async () => undefined,
      readUserLocale: async () => undefined,
      promptLanguage: async () => 'zh-CN',
      persistUserLocale: persist,
    });
    expect(decision.mode).toBe('onboarding-required');
    expect(decision.locale).toBe('zh-CN');
    expect(persist).toHaveBeenCalledWith('zh-CN');
  });

  it('已有持久化 locale → continue（绝不重复引导）', async () => {
    const decision = await runSetupWizard({
      argv: [],
      env: {},
      isTTY: true,
      systemLocale: 'zh-CN',
      readWorkspaceLocale: async () => undefined,
      readUserLocale: async () => 'en',
      promptLanguage: async () => 'zh-CN',
      persistUserLocale: async () => {},
    });
    expect(decision.mode).toBe('continue');
    expect(decision.locale).toBe('en');
  });

  it('--help/--version 经向导仍 print-and-exit（零副作用承诺）', async () => {
    const decision = await runSetupWizard({
      argv: ['--version'],
      env: {},
      isTTY: false,
      systemLocale: 'en',
      readWorkspaceLocale: async () => undefined,
      readUserLocale: async () => undefined,
      promptLanguage: async () => 'en',
      persistUserLocale: async () => {},
    });
    expect(decision.mode).toBe('print-and-exit');
    expect(decision.output).toBe('version');
  });
});
