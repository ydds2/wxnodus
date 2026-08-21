// tests/v4-output-tui.test.tsx — V4 L0-3 渲染层测试：bridge 纯函数 + tui 渲染器 +
// messageLine 切片行为（spec 单一事实源驱动的三分支）
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { DEFAULT_THEME } from '../src/wxnodus-ui/theme.js';
import { msgToOutputEvents } from '../src/wxnodus-ui/output/bridge.js';
import { renderEvent } from '../src/wxnodus-ui/output/spec.js';
import { BlockListView } from '../src/wxnodus-ui/output/tui.js';
import { MessageLine } from '../src/wxnodus-ui/components/messageLine.js';
import type { Msg } from '../src/wxnodus-ui/types.js';

const t = DEFAULT_THEME;
const line = (msg: Partial<Msg> & Pick<Msg, 'role' | 'text'>) =>
  render(<MessageLine cols={100} msg={msg as Msg} t={t} />).lastFrame?.() ?? (() => '');

describe('V4 L0-3 bridge：Msg → OutputEvent 纯函数', () => {
  it('tool 消息 → tool-result（工具名从「name: 」前缀提取；toolOutcome 透传）', () => {
    const ev = msgToOutputEvents({ role: 'tool', text: 'fs_edit: 已替换 1 处', toolOutcome: 'failed' })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'tool-result', name: 'fs_edit', outcome: 'failed' })
    // 未标注 outcome：中性 ok（不猜失败）
    expect(msgToOutputEvents({ role: 'tool', text: 'fs_read: 内容' })[0]).toMatchObject({ outcome: 'ok' })
  });

  it('event 消息 → session-event（eventType 透传）', () => {
    const ev = msgToOutputEvents({ role: 'system', text: '已切换', kind: 'event', eventType: 'session.switched' })
    expect(ev[0]).toMatchObject({ kind: 'session-event', type: 'session.switched' })
  });

  it('trail 消息 → reasoning + turn-summary（turnSummary 结构化透传；无思考仅摘要）', () => {
    const ev = msgToOutputEvents({
      role: 'system', kind: 'trail', text: '',
      thinking: '思考中', thinkingTokens: 300, toolTokens: 500,
      turnSummary: { turns: 3, tokens: 800, costUsd: 0, durationMs: 2100 },
    })
    expect(ev.map(e => e.kind)).toEqual(['reasoning', 'turn-summary'])
    expect(ev[1]).toMatchObject({ turns: 3, tokens: 800, durationMs: 2100 })
    // 无思考无数据 → 空（不渲染）
    expect(msgToOutputEvents({ role: 'system', kind: 'trail', text: '' })).toEqual([])
  });

  it('user/assistant/diff 暂不归 spec 管（L0-6 全量切换时并入）', () => {
    expect(msgToOutputEvents({ role: 'user', text: 'hi' })).toEqual([])
    expect(msgToOutputEvents({ role: 'assistant', text: 'ok' })).toEqual([])
  });
});

describe('V4 L0-3 tui 渲染器：RenderBlock → ink', () => {
  it('turn-summary 行：◦ N 调用 · tokens · 时长（spec 格式）', () => {
    const blocks = renderEvent({ kind: 'turn-summary', turns: 3, tokens: 8400, costUsd: 0, durationMs: 2100 }, 'cozy')
    const frame = render(<BlockListView blocks={blocks} t={t} />).lastFrame?.() ?? ''
    expect(frame).toContain('◦ 3 调用 · 8.4k tokens · 2.1s')
  });

  it('cost>0 时显示成本段；cost=0 不显示', () => {
    const withCost = renderEvent({ kind: 'turn-summary', turns: 1, tokens: 100, costUsd: 0.0123, durationMs: 500 }, 'cozy')
    expect((render(<BlockListView blocks={withCost} t={t} />).lastFrame?.() ?? '')).toContain('$0.0123')
    const noCost = renderEvent({ kind: 'turn-summary', turns: 1, tokens: 100, costUsd: 0, durationMs: 500 }, 'cozy')
    expect((render(<BlockListView blocks={noCost} t={t} />).lastFrame?.() ?? '')).not.toContain('$')
  });

  it('工具结果 ⎿ 行 + failed 红色语义（结构化 outcome）', () => {
    const blocks = renderEvent({ kind: 'tool-result', name: 'bash', outcome: 'failed', preview: '命令退出码 1' }, 'cozy')
    const frame = render(<BlockListView blocks={blocks} t={t} />).lastFrame?.() ?? ''
    expect(frame).toContain('⎿')
    expect(frame).toContain('命令退出码 1')
  });

  it('统一折叠头：▸ 标题 (badge)', () => {
    const blocks = renderEvent({ kind: 'reasoning', text: '思考全文……', tokens: 2048 }, 'cozy')
    const frame = render(<BlockListView blocks={blocks} t={t} />).lastFrame?.() ?? ''
    expect(frame).toContain('▸ 推理 (2.0k tokens)')
  });
});

describe('V4 L0-3 messageLine 切片行为（spec 驱动三分支）', () => {
  it('timeline 事件走 spec：◈ 字形 + 文本可见', () => {
    const frame = line({ role: 'system', kind: 'event', eventType: 'session.switched', text: '已切换到会话 s9' })
    expect(frame).toContain('◈')
    expect(frame).toContain('已切换到会话 s9')
  });

  it('工具结果行走 spec：⎿ + 预览可见（outcome 着色由结构化字段决定）', () => {
    const frame = line({ role: 'tool', text: 'fs_edit: 已替换 app.ts 中 1 处', toolOutcome: 'ok' })
    expect(frame).toContain('⎿')
    expect(frame).toContain('已替换 app.ts 中 1 处')
  });

  it('trail 消息：turn-summary 回合尾行（◦ N 调用 · tokens · 时长）', () => {
    const frame = line({
      role: 'system', kind: 'trail', text: '',
      turnSummary: { turns: 4, tokens: 6200, costUsd: 0, durationMs: 8500 },
    })
    expect(frame).toContain('◦ 4 调用 · 6.2k tokens · 8.5s')
  });

  it('trail 含思考：统一折叠头 ▸ 推理 (N tokens)', () => {
    const frame = line({
      role: 'system', kind: 'trail', text: '',
      thinking: '先看入口文件……', thinkingTokens: 512,
    })
    expect(frame).toContain('▸ 推理 (512 tokens)')
  });

  it('空 trail（无思考无数据）不渲染', () => {
    const frame = line({ role: 'system', kind: 'trail', text: '' })
    expect((frame ?? '').trim()).toBe('')
  });
});
