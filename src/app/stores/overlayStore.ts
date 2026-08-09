// src/app/stores/overlayStore.ts — L5 弹层状态（zustand）
import { create } from 'zustand';
import type { OverlayState } from './types.js';

const initial: OverlayState = { approval: null, clarify: null, confirm: null, panel: false, sessions: false, pager: null };

export const useOverlay = create<{ s: OverlayState }>(() => ({ s: initial }));
export const getOverlay = () => useOverlay.getState().s;
export const patchOverlay = (p: Partial<OverlayState>) => useOverlay.setState({ s: { ...getOverlay(), ...p } });

// 只清流程性弹层（审批/澄清/确认），保留用户主动打开的（会话/面板/pager）
export const resetFlowOverlays = () =>
  useOverlay.setState({ s: { ...getOverlay(), approval: null, clarify: null, confirm: null } });
