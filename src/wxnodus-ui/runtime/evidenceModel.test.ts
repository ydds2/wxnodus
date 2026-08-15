// src/wxnodus-ui/runtime/evidenceModel.test.ts — 阶段 2：证据状态机纯 reducer 合同
// 核心红线：只有显式验证成功事件能进入 verified；助手文案/工具成功不是本模型的事件类型。
import { describe, expect, it } from 'vitest';
import { evidenceReducer, evidenceStatusOf, evidenceOverall, type EvidenceSnapshot } from './evidenceModel.js';

const empty = (): EvidenceSnapshot => ({ items: {} });

describe('evidenceReducer 状态机', () => {
  it('verification.succeeded 才能进入 verified，并保留来源事件标识', () => {
    const s = evidenceReducer(empty(), {
      type: 'verification.succeeded', id: 'e1', sourceEvent: 'verification#42', artifactRef: 'out/check.log', at: 1000,
    });
    expect(evidenceStatusOf(s, 'e1')).toBe('verified');
    expect(s.items['e1']).toMatchObject({ sourceEvent: 'verification#42', artifactRef: 'out/check.log' });
  });

  it('failed 不进入 verified；reason 保留', () => {
    const s = evidenceReducer(empty(), { type: 'verification.failed', id: 'e1', reason: '启动超时', at: 1000 });
    expect(evidenceStatusOf(s, 'e1')).toBe('failed');
    expect(s.items['e1']?.failedReason).toBe('启动超时');
  });

  it('interrupted 保留 interrupted 状态，不变成成功', () => {
    const s = evidenceReducer(empty(), { type: 'verification.interrupted', id: 'e1', at: 1000 });
    expect(evidenceStatusOf(s, 'e1')).toBe('interrupted');
  });

  it('unavailable 保留 unavailable；缺省状态为 unknown', () => {
    const s = evidenceReducer(empty(), { type: 'verification.unavailable', id: 'e1', reason: '无读回通道', at: 1000 });
    expect(evidenceStatusOf(s, 'e1')).toBe('unavailable');
    expect(evidenceStatusOf(empty(), '不存在')).toBe('unknown');
  });

  it('failed 之后只有新的 succeeded 事件才能翻转为 verified', () => {
    let s = evidenceReducer(empty(), { type: 'verification.failed', id: 'e1', reason: 'x', at: 1000 });
    s = evidenceReducer(s, { type: 'verification.succeeded', id: 'e1', sourceEvent: 'retry#7', at: 2000 });
    expect(evidenceStatusOf(s, 'e1')).toBe('verified');
    expect(s.items['e1']?.failedReason).toBeUndefined();
  });

  it('同一 id 的 running → succeeded 生命周期按时间推进', () => {
    let s = evidenceReducer(empty(), { type: 'verification.started', id: 'e1', summary: '探活', at: 1000 });
    expect(evidenceStatusOf(s, 'e1')).toBe('running');
    s = evidenceReducer(s, { type: 'verification.succeeded', id: 'e1', sourceEvent: 'ok#1', at: 1500 });
    expect(evidenceStatusOf(s, 'e1')).toBe('verified');
    expect(s.items['e1']).toMatchObject({ startedAt: 1000, finishedAt: 1500 });
  });
});

describe('evidenceOverall 汇总', () => {
  const snap = (events: Parameters<typeof evidenceReducer>[1][]) => events.reduce(evidenceReducer, empty());

  it('全 verified 且非空 → verified', () => {
    const s = snap([
      { type: 'verification.succeeded', id: 'a', sourceEvent: 'x1', at: 1 },
      { type: 'verification.succeeded', id: 'b', sourceEvent: 'x2', at: 2 },
    ]);
    expect(evidenceOverall(s)).toBe('verified');
  });

  it('任一 failed → failed（即使其他 verified）', () => {
    const s = snap([
      { type: 'verification.succeeded', id: 'a', sourceEvent: 'x1', at: 1 },
      { type: 'verification.failed', id: 'b', reason: 'r', at: 2 },
    ]);
    expect(evidenceOverall(s)).toBe('failed');
  });

  it('有 pending/running 时 → pending（不提前宣告 verified）', () => {
    const s = snap([
      { type: 'verification.started', id: 'a', summary: 's', at: 1 },
      { type: 'verification.succeeded', id: 'b', sourceEvent: 'x2', at: 2 },
    ]);
    expect(evidenceOverall(s)).toBe('pending');
  });

  it('interrupted 优先于 pending', () => {
    const s = snap([
      { type: 'verification.started', id: 'a', summary: 's', at: 1 },
      { type: 'verification.interrupted', id: 'b', at: 2 },
    ]);
    expect(evidenceOverall(s)).toBe('interrupted');
  });

  it('空快照 → unknown（缺失证据绝不冒充成功）', () => {
    expect(evidenceOverall(empty())).toBe('unknown');
  });
});
