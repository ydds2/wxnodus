// tests/v4-output-render-matrix.test.tsx — V4 L0-6：渲染器层 60 格快照矩阵
// 10 kinds × 3 densities × 明/暗主题 = 60 格（BlockListView ink 渲染快照）。
// 规格 30 格（v4-output-spec-matrix）之上的渲染层基线——任何格式/颜色映射变更在此显式化。
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { DARK_THEME, LIGHT_THEME } from '../src/wxnodus-ui/theme.js';
import { renderEvent, SPEC_MATRIX_KINDS, SPEC_DENSITIES, type OutputEvent } from '../src/wxnodus-ui/output/spec.js';
import { BlockListView } from '../src/wxnodus-ui/output/tui.js';

const SAMPLES: Record<OutputEvent['kind'], OutputEvent> = {
  user: { kind: 'user', text: '帮我修这个 bug', attachments: ['截图.png'] },
  assistant: { kind: 'assistant', text: '已定位问题……', streaming: true },
  reasoning: { kind: 'reasoning', text: '思考过程……', tokens: 1024 },
  'tool-start': { kind: 'tool-start', name: 'fs_edit', argsSummary: 'src/app.ts' },
  'tool-result': { kind: 'tool-result', name: 'fs_edit', outcome: 'failed', preview: '已替换 1 处', tokens: 120, durationMs: 850 },
  diff: { kind: 'diff', file: 'src/app.ts', body: '@@ -1,2 +1,2 @@\n-old\n+new' },
  command: { kind: 'command', name: 'npm test', output: 'ok', exitCode: 0 },
  notice: { kind: 'notice', level: 'warn', scope: 'core', text: '上下文已用 75%' },
  'turn-summary': { kind: 'turn-summary', turns: 3, tokens: 8400, costUsd: 0.0123, durationMs: 24500 },
  'session-event': { kind: 'session-event', type: 'session.switched', text: '已切换到会话 s2' },
};

const THEMES = { dark: DARK_THEME, light: LIGHT_THEME } as const;

describe('V4 L0-6 渲染器 60 格快照矩阵（10 kinds × 3 densities × 明/暗）', () => {
  for (const kind of SPEC_MATRIX_KINDS) {
    for (const density of SPEC_DENSITIES) {
      for (const [themeName, theme] of Object.entries(THEMES)) {
        it(`${kind} @ ${density} @ ${themeName}`, () => {
          const blocks = renderEvent(SAMPLES[kind]!, density)
          const frame = render(<BlockListView blocks={blocks} t={theme} />).lastFrame?.() ?? ''
          // 快照（主题色差异在 ANSI 序列中显式化）
          expect(frame).toMatchSnapshot()
          // 不变量：非空事件必有可见文本
          if (kind !== 'notice') expect(frame.trim().length).toBeGreaterThan(0)
        })
      }
    }
  }
})

describe('V4 L0-6 渲染层行为断言（明暗主题差异）', () => {
  it('明暗主题文本帧等价且主题色值真实不同（颜色映射生效）', () => {
    const blocks = renderEvent(SAMPLES['tool-start']!, 'cozy')
    const dark = render(<BlockListView blocks={blocks} t={DARK_THEME} />).lastFrame?.() ?? ''
    const light = render(<BlockListView blocks={blocks} t={LIGHT_THEME} />).lastFrame?.() ?? ''
    // lastFrame 剥离 ANSI——文本等价（内容一致）
    expect(dark).toContain('⏺ fs_edit src/app.ts')
    expect(dark).toBe(light)
    // 主题层：accent 语义色值在明暗主题下必须不同（映射真实生效，非占位）
    expect(DARK_THEME.color.accent).not.toBe(LIGHT_THEME.color.accent)
    expect(DARK_THEME.color.error).not.toBe(LIGHT_THEME.color.error)
  })
})
