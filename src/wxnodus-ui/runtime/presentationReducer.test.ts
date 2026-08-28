// src/wxnodus-ui/runtime/presentationReducer.test.ts — 阶段 2：presentation read-model 纯 reducer 合同
// 验收点：同一事件序列 → 确定快照；streaming 不丢不重；证据只能来自真实验证事件；
// 旧 session 迟到事件不改当前会话；未知事件不破坏快照。
import { describe, expect, it } from 'vitest';
import {
  presentationReducer,
  isStaleEvent,
  initialPresentationState,
  type PresentationEvent,
  type PresentationEventBody,
  type PresentationState,
} from './presentationReducer.js';

const ev = (e: PresentationEventBody): PresentationEvent =>
  ({ sessionId: 's1', generation: 1, ...e }) as PresentationEvent;

const run = (events: PresentationEvent[]) => events.reduce(presentationReducer, initialPresentationState());

describe('presentationReducer 确定性', () => {
  it('同一事件序列得到深度相等的确定性快照', () => {
    const seq = [
      ev({ type: 'turn.start' }),
      ev({ type: 'message.delta', text: '你' }),
      ev({ type: 'message.delta', text: '好' }),
      ev({ type: 'tool.start', id: 't1', name: 'bash', context: 'pwd' }),
      ev({ type: 'tool.complete', id: 't1', ok: true, summary: 'ok' }),
      ev({ type: 'message.complete', text: '你好' }),
    ];
    expect(run(seq)).toEqual(run(seq));
  });

  it('streaming 增量累积，complete 后进入 history 且 live 清空（不丢不重）', () => {
    const s = run([
      ev({ type: 'turn.start' }),
      ev({ type: 'message.delta', text: '部分' }),
      ev({ type: 'message.complete', text: '部分完成' }),
    ]);
    expect(s.streaming).toBe('');
    expect(s.history.map(m => m.text)).toEqual(['部分完成']);
    expect(s.busy).toBe(false);
  });

  it('工具生命周期进入 activity 并保持顺序', () => {
    const s = run([
      ev({ type: 'turn.start' }),
      ev({ type: 'tool.start', id: 't1', name: 'bash', context: 'npm test' }),
      ev({ type: 'tool.complete', id: 't1', ok: false, summary: 'exit 1' }),
    ]);
    expect(s.activity).toMatchObject([
      { toolId: 't1', name: 'bash', status: 'running' },
      { toolId: 't1', name: 'bash', status: 'failed', summary: 'exit 1' },
    ]);
  });

  it('evidence 只能经 verification 事件进入；verified 必须有来源事件', () => {
    const s = run([
      ev({ type: 'evidence', event: { type: 'verification.succeeded', id: 'e1', sourceEvent: 'verification#9', at: 1 } }),
    ]);
    expect(s.evidence.items['e1']?.status).toBe('verified');
    expect(s.evidence.items['e1']?.sourceEvent).toBe('verification#9');
  });

  it('blocking prompt 按严格优先级 approval→confirm→clarify→sudo→secret→form', () => {
    const seq: PresentationEvent[] = [
      ev({ type: 'prompt.opened', kind: 'form', id: 'f1', summary: '表单' }),
      ev({ type: 'prompt.opened', kind: 'secret', id: 's1', summary: '令牌' }),
      ev({ type: 'prompt.opened', kind: 'sudo', id: 'u1', summary: 'sudo' }),
      ev({ type: 'prompt.opened', kind: 'clarify', id: 'c1', summary: '澄清' }),
      ev({ type: 'prompt.opened', kind: 'confirm', id: 'o1', summary: '确认' }),
      ev({ type: 'prompt.opened', kind: 'approval', id: 'a1', summary: '批准' }),
    ]
    let s = run(seq)
    expect(s.blockingPrompt?.kind).toBe('approval')
    expect(s.openPrompts).toHaveLength(6)

    // 清除高优先级 prompt 后依次回落（隐藏 prompt 不丢失）
    const fallback: Array<[string, 'confirm' | 'clarify' | 'sudo' | 'secret' | 'form']> = [
      ['a1', 'confirm'],
      ['o1', 'clarify'],
      ['c1', 'sudo'],
      ['u1', 'secret'],
      ['s1', 'form'],
    ]
    for (const [id, nextKind] of fallback) {
      s = presentationReducer(s, ev({ type: 'prompt.closed', id }))
      expect(s.blockingPrompt?.kind).toBe(nextKind)
    }

    s = presentationReducer(s, ev({ type: 'prompt.closed', id: 'f1' }))
    expect(s.blockingPrompt).toBeNull()
  });
});

describe('session/generation 守卫', () => {
  it('旧 session 迟到事件不修改当前会话', () => {
    const s = presentationReducer(initialPresentationState(), ev({ type: 'turn.start' }));
    const after = presentationReducer(s, {
      sessionId: 's-old', generation: 1, type: 'message.delta', text: '迟到',
    });
    expect(after).toEqual(s);
  });

  it('同 session 旧 generation 事件被丢弃（isStaleEvent）', () => {
    const state: PresentationState = { ...initialPresentationState(), sessionId: 's1', generation: 2 };
    expect(isStaleEvent(state, { sessionId: 's1', generation: 1, type: 'message.delta', text: '旧' })).toBe(true);
    expect(isStaleEvent(state, { sessionId: 's1', generation: 2, type: 'message.delta', text: '新' })).toBe(false);
  });

  it('session.changed 提升 generation 并清空回合态', () => {
    const s0 = run([
      ev({ type: 'turn.start' }),
      ev({ type: 'message.delta', text: '跨会话残留' }),
    ]);
    const s1 = presentationReducer(s0, { sessionId: 's2', generation: 3, type: 'session.changed' });
    expect(s1.sessionId).toBe('s2');
    expect(s1.generation).toBe(3);
    expect(s1.streaming).toBe('');
    expect(s1.history).toEqual([]);
    expect(s1.busy).toBe(false);
  });
});
