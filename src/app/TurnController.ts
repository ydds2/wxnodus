// src/app/TurnController.ts — L5 回合状态机（流式分片/工具生命周期/中断/错误）
// 设计（参考业界 turn 控制器思想，自有实现）：token 累积 → 段边界 flush → 工具生命周期 → 回合归档
import { patchTurn, pushSegment, upsertTool, pushTrail, getTurn } from './stores/turnStore.js';
import { patchUi } from './stores/uiStore.js';

let buf = '';
let toolStart: Record<string, number> = {};
let seq = 0;
const nid = () => `m${++seq}`;

export const turnController = {
  startMessage() {
    buf = ''; toolStart = {};
    patchTurn({ busy: true, interrupted: false, streaming: '', streamSegments: [], tools: [], reasoning: '', reasoningActive: false, turnTrail: [] });
    patchUi({ busy: true, stage: 'work' });
  },
  recordDelta(text: string) {
    buf += text;
    patchTurn({ streaming: buf });
  },
  flushSegment() {
    const text = buf;
    buf = '';
    if (!text.trim()) return;
    pushSegment({ id: nid(), role: 'assistant', text });
    patchTurn({ streaming: '' });
  },
  recordReasoning(text: string) {
    patchTurn({ reasoning: text, reasoningActive: true });
  },
  recordToolStart(name: string, ctx: string) {
    toolStart[`${name}::${ctx}`] = Date.now();
    if (buf.trim()) this.flushSegment();
    upsertTool({ name, ctx, startedAt: Date.now(), done: false });
  },
  recordToolProgress(name: string, ctx: string, detail: string) {
    upsertTool({ name, ctx, startedAt: toolStart[`${name}::${ctx}`] ?? Date.now(), detail, done: false });
  },
  recordToolComplete(name: string, ctx: string, ok: boolean, detail: string, ms: number) {
    upsertTool({ name, ctx, startedAt: toolStart[`${name}::${ctx}`] ?? Date.now(), detail, done: true, ok });
    pushTrail(`${name}("${ctx}") (${(ms / 1000).toFixed(1)}s) :: ${detail} ${ok ? '✓' : '✗'}`);
  },
  recordMessageComplete(ms: number) {
    if (buf.trim()) this.flushSegment();
    patchTurn({ busy: false, tools: [] });
    patchUi({ busy: false, stage: 'idle' });
  },
  interruptTurn() {
    patchTurn({ interrupted: true, busy: false, streaming: '' });
    patchUi({ busy: false, stage: 'idle' });
  },
  recordError(msg: string) {
    pushSegment({ id: nid(), role: 'system', text: msg, error: true });
    this.interruptTurn();
  },
  reset() {
    buf = ''; toolStart = {};
  },
};
