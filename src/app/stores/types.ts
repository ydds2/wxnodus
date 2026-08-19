// src/app/stores/types.ts — L5 编排层类型（消息/工具/回合状态）
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type Kind = 'intro' | 'panel' | 'slash' | 'trail' | 'diff';

export interface UiMsg {
  id: string;
  role: Role;
  kind?: Kind;
  text: string;
  ms?: number;
  error?: boolean;
}

export interface ActiveTool {
  name: string;
  ctx: string;
  startedAt: number;
  detail?: string;
  done?: boolean;
  ok?: boolean;
}

export interface TurnState {
  streaming: string;
  streamSegments: UiMsg[];
  tools: ActiveTool[];
  reasoning: string;
  reasoningActive: boolean;
  todos: Array<{ text: string; done: boolean }>;
  busy: boolean;
  interrupted: boolean;
  turnTrail: string[];
}

export type Mode = 'smart' | 'auto' | 'manual' | 'plan' | 'yolo' | 'goal';

export interface UiState {
  busy: boolean;
  mode: Mode;
  model: string;
  sessionId: string | null;
  cwd: string;
  contextPct: number;
  clock: string;
  stage: string;
  themeName: string;
  notice: string | null;
  thinking: boolean; // 推理（Thinking）显示开关
}

export interface OverlayState {
  approval: { title: string; detail: string; allowPermanent: boolean } | null;
  clarify: { question: string; options: string[] } | null;
  confirm: { text: string; danger: boolean } | null;
  sessions: boolean;
  modelPicker: boolean;
  configPanel: boolean;
  pager: { title: string; lines: string[] } | null;
}
