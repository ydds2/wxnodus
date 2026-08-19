// ⚠ 2026-08-19 反虚假审计：本文件属 legacy zustand 编排层——当前运行时不接线（真实状态在 src/wxnodus-ui/runtime/promptStore.ts + flowController.ts），保留为已测测试面与迁移锚点，勿误认为生产路径
// src/app/stores/turnStore.ts — L5 回合状态（自研引擎 engine.ts）
import { createStore as create } from './engine.js';
import type { TurnState, UiMsg, ActiveTool } from './types.js';

const initial: TurnState = {
  streaming: '', streamSegments: [], tools: [], reasoning: '', reasoningActive: false,
  todos: [], busy: false, interrupted: false, turnTrail: [],
};

export const useTurn = create<{ s: TurnState }>(() => ({ s: initial }));
export const getTurn = () => useTurn.getState().s;
export const patchTurn = (p: Partial<TurnState>) => useTurn.setState({ s: { ...getTurn(), ...p } });
export const resetTurn = () => useTurn.setState({ s: initial });

export const pushSegment = (m: UiMsg) => patchTurn({ streamSegments: [...getTurn().streamSegments, m] });
export const upsertTool = (t: ActiveTool) =>
  patchTurn({ tools: [...getTurn().tools.filter(x => !(x.name === t.name && x.ctx === t.ctx)), t] });
export const pushTrail = (line: string) => patchTurn({ turnTrail: [...getTurn().turnTrail, line] });
