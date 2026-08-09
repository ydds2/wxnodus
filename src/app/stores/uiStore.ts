// src/app/stores/uiStore.ts — L5 UI 状态（zustand）
import { create } from 'zustand';
import type { UiState } from './types.js';

const initial: UiState = {
  busy: false, mode: 'auto', model: '', sessionId: null, cwd: process.cwd(),
  contextPct: 0, clock: '', stage: 'idle', themeName: 'kimi', notice: null,
};

export const useUi = create<{ s: UiState }>(() => ({ s: initial }));
export const getUi = () => useUi.getState().s;
export const patchUi = (p: Partial<UiState>) => useUi.setState({ s: { ...getUi(), ...p } });
