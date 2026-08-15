// src/wxnodus-ui/runtime/presentationStore.test.ts — 阶段 2：read-model 存取 seam 合同
import { afterEach, describe, expect, it } from 'vitest';
import {
  dispatchPresentationEvent,
  getPresentationState,
  resetPresentationState,
} from './presentationStore.js';

afterEach(() => {
  resetPresentationState();
});

describe('presentationStore seam', () => {
  it('dispatch → 确定性快照；reset → 回到初始态', () => {
    dispatchPresentationEvent({ sessionId: 's1', generation: 1, type: 'turn.start' });
    dispatchPresentationEvent({ sessionId: 's1', generation: 1, type: 'message.delta', text: 'hello' });

    expect(getPresentationState().streaming).toBe('hello');
    expect(getPresentationState().busy).toBe(true);
    expect(getPresentationState().sessionId).toBe('s1');

    resetPresentationState();
    expect(getPresentationState().streaming).toBe('');
    expect(getPresentationState().busy).toBe(false);
    expect(getPresentationState().sessionId).toBeNull();
  });

  it('旧 session/旧 generation 事件经 store 同样被丢弃', () => {
    dispatchPresentationEvent({ sessionId: 's1', generation: 1, type: 'turn.start' });
    const before = getPresentationState();

    dispatchPresentationEvent({ sessionId: 's-old', generation: 1, type: 'message.delta', text: '迟到' });
    expect(getPresentationState()).toEqual(before);

    dispatchPresentationEvent({ sessionId: 's1', generation: 0, type: 'message.delta', text: '旧代数' });
    expect(getPresentationState()).toEqual(before);
  });

  it('证据事件进入 read-model 且只经 verification 事件', () => {
    dispatchPresentationEvent({ sessionId: 's1', generation: 1, type: 'turn.start' });
    dispatchPresentationEvent({
      sessionId: 's1', generation: 1, type: 'evidence',
      event: { type: 'verification.succeeded', id: 'e1', sourceEvent: 'v#1', at: 1 },
    });
    expect(getPresentationState().evidence.items['e1']?.status).toBe('verified');
  });
});
