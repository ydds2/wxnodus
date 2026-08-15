// src/wxnodus-ui/components/turnSections.test.tsx — 阶段 6：回合分区展示渲染合同
// 关键断言：验证/证据只能来自真实验证事件——空数据必须诚实显示待验证/不渲染，
// 绝不出现「已验证」；窄宽度不溢出。
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { patchTurnState, resetTurnState } from '../runtime/flowStore.js';
import { resetUiState, patchUiState } from '../runtime/viewStore.js';
import { dispatchPresentationEvent, resetPresentationState } from '../runtime/presentationStore.js';
import { TurnSections } from './turnSections.js';

afterEach(() => {
  resetTurnState();
  resetUiState();
  resetPresentationState();
});

const renderSections = (cols = 80) => render(<TurnSections cols={cols} />);

describe('计划分区', () => {
  it('有未完成项 → 展开显示清单与计数', () => {
    patchUiState({ busy: true });
    patchTurnState({
      todos: [
        { id: 'a', content: '安装依赖', status: 'completed' },
        { id: 'b', content: '启动服务', status: 'in_progress' },
        { id: 'c', content: '读回验证', status: 'pending' },
      ],
    });
    const { lastFrame } = renderSections();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('计划');
    expect(frame).toContain('1/3');
    expect(frame).toContain('启动服务');
    expect(frame).toContain('读回验证');
  });

  it('全部完成 → 默认收起（不显示条目，仍显示计数）', () => {
    patchUiState({ busy: true });
    patchTurnState({
      todos: [
        { id: 'a', content: '安装依赖', status: 'completed' },
        { id: 'b', content: '读回验证', status: 'completed' },
      ],
    });
    const { lastFrame } = renderSections();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('计划');
    expect(frame).toContain('2/2');
    expect(frame).not.toContain('安装依赖');
  });
});

describe('活动分区', () => {
  it('运行中工具 + 已完成计数单行摘要', () => {
    patchUiState({ busy: true });
    patchTurnState({
      tools: [{ id: 't1', name: 'Bash', context: 'npm test', startedAt: 1 }],
      turnTrail: ['line-1', 'line-2'],
    });
    const { lastFrame } = renderSections();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('活动');
    expect(frame).toContain('Bash(npm test)');
    expect(frame).toContain('运行中');
    expect(frame).toContain('2 项已完成');
  });
});

describe('修改分区', () => {
  it('一行摘要：修改 N 个文件 · +A -D（默认收起 hunk）', () => {
    patchUiState({ busy: true });
    patchTurnState({
      streamSegments: [
        { kind: 'diff', role: 'assistant', text: '```diff\n--- a/x\n+++ b/x\n@@\n-old\n+new\n```' },
      ],
    });
    const { lastFrame } = renderSections();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('修改');
    expect(frame).toContain('修改 1 个文件 · +1 -1');
    expect(frame).not.toContain('+new');
  });
});

describe('验证/证据分区（诚实性红线）', () => {
  it('busy 且无真实验证事件 → 显示「等待真实验证事件 · 待验证」，绝无「已验证」', () => {
    patchUiState({ busy: true });
    const { lastFrame } = renderSections();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('验证');
    expect(frame).toContain('等待真实验证事件');
    expect(frame).toContain('待验证');
    expect(frame).not.toContain('已验证');
    expect(frame).not.toContain('证据');
  });

  it('只有真实验证事件后才能显示已验证与证据区（含来源事件标识）', () => {
    patchUiState({ busy: true });
    dispatchPresentationEvent({ sessionId: 's1', generation: 1, type: 'turn.start' });
    dispatchPresentationEvent({
      sessionId: 's1', generation: 1, type: 'evidence',
      event: { type: 'verification.succeeded', id: 'e1', sourceEvent: 'verification#9', summary: '探活通过', artifactRef: 'out/check.log', at: 1 },
    });
    const { lastFrame } = renderSections();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('已验证');
    expect(frame).toContain('探活通过');
    expect(frame).toContain('来源 verification#9');
    expect(frame).toContain('证据');
  });

  it('空闲且无证据项 → 分区整体不渲染（低噪声）', () => {
    const { lastFrame } = renderSections();
    expect(lastFrame() ?? '').not.toContain('计划');
    expect(lastFrame() ?? '').not.toContain('验证');
  });
});

describe('窄宽度不溢出', () => {
  it.each([40, 60, 80, 120])('%d 列渲染不抛错', (cols) => {
    patchUiState({ busy: true });
    patchTurnState({
      todos: [{ id: 'a', content: '安装依赖', status: 'in_progress' }],
      tools: [{ id: 't1', name: 'Bash', context: 'npm run test-with-a-very-long-name', startedAt: 1 }],
      streamSegments: [
        { kind: 'diff', role: 'assistant', text: '```diff\n--- a/x\n+++ b/x\n@@\n-old\n+new\n```' },
      ],
    });
    expect(() => renderSections(cols)).not.toThrow();
  });
});
