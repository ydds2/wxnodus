// src/app/stores/uiStore.ts — L5 UI 状态（自研引擎 engine.ts）
import { createStore as create } from './engine.js';
import type { UiState } from './types.js';

const initial: UiState = {
  busy: false, mode: 'auto', model: '', sessionId: null, cwd: process.cwd(),
  contextPct: 0, clock: '', stage: 'idle', themeName: 'kimi', notice: null, thinking: true,
};

export const useUi = create<{ s: UiState }>(() => ({ s: initial }));
export const getUi = () => useUi.getState().s;
export const patchUi = (p: Partial<UiState>) => useUi.setState({ s: { ...getUi(), ...p } });
