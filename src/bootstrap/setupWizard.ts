// src/bootstrap/setupWizard.ts — R13 bootstrap：首次安装引导（zh/en）唯一入口
// 单一事实源：CLI pre-bootstrap 只经 runSetupWizard 决策——首次安装（无 locale 文件 + TTY）
// 必须进入 onboarding-required（真实引导，绝不假引导）；已有 locale / 非交互 → continue。
import { decidePreBootstrap, type DecidePreBootstrapInput, type PreBootstrapDecision } from '../application/bootstrap/preBootstrapOnboarding.js';

export { type PreBootstrapDecision, type PreBootstrapArgs } from '../application/bootstrap/preBootstrapOnboarding.js';

/** 首次安装引导唯一入口（委托 pre-bootstrap 决策器——接线与语义同源，不复制逻辑） */
export async function runSetupWizard(input: DecidePreBootstrapInput): Promise<PreBootstrapDecision> {
  return decidePreBootstrap(input);
}
