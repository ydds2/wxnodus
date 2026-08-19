// ⚠ 2026-08-19 反虚假审计：本文件属 legacy zustand 编排层——当前运行时不接线（真实状态在 src/wxnodus-ui/runtime/promptStore.ts + flowController.ts），保留为已测测试面与迁移锚点，勿误认为生产路径
// src/app/stores/overlayStore.ts — L5 弹层状态（自研引擎 engine.ts）
import { createStore as create } from './engine.js';
import type { OverlayState } from './types.js';

const initial: OverlayState = { approval: null, clarify: null, confirm: null, sessions: false, modelPicker: false, configPanel: false, pager: null };

export const useOverlay = create<{ s: OverlayState }>(() => ({ s: initial }));
export const getOverlay = () => useOverlay.getState().s;
export const patchOverlay = (p: Partial<OverlayState>) => useOverlay.setState({ s: { ...getOverlay(), ...p } });

// 只清流程性弹层（审批/澄清/确认），保留用户主动打开的（会话/面板/pager）
export const resetFlowOverlays = () =>
  useOverlay.setState({ s: { ...getOverlay(), approval: null, clarify: null, confirm: null } });
