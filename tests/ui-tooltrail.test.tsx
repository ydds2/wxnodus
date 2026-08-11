// tests/ui-tooltrail.test.tsx — A20 ToolTrail 精简：✓/✗ 标记显示、过渡行删除、耗时修复验证
import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'

import { ToolTrail } from '../src/wxnodus-ui/components/thinking.js'
import { DEFAULT_THEME } from '../src/wxnodus-ui/theme.js'

describe('A20 ToolTrail 精简', () => {
  it('trail 行显示 ✓ 完成标记（此前 mark 解析了却不渲染）', () => {
    const { lastFrame } = render(
      <ToolTrail
        t={DEFAULT_THEME}
        trail={['Fs Read("x.txt") (0.0s) :: 读取完成 ✓']}
        detailsMode="expanded"
        sections={{ tools: 'expanded', thinking: 'hidden', subagents: 'hidden', activity: 'hidden' }}
      />
    )
    const frame = lastFrame()
    expect(frame).toContain('✓')
    expect(frame).toContain('Fs Read')
  })

  it('失败 trail 行显示 ✗ 标记', () => {
    const { lastFrame } = render(
      <ToolTrail
        t={DEFAULT_THEME}
        trail={['Bash("ls") (1.2s) :: 文件不存在 ✗']}
        detailsMode="expanded"
        sections={{ tools: 'expanded', thinking: 'hidden', subagents: 'hidden', activity: 'hidden' }}
      />
    )
    expect(lastFrame()).toContain('✗')
  })

  it('过渡行 analyzing tool output… 不再渲染（精简噪音）', () => {
    const { lastFrame } = render(
      <ToolTrail
        t={DEFAULT_THEME}
        trail={['analyzing tool output…', 'Fs Read("x") (0.5s) :: ok ✓']}
        detailsMode="expanded"
        sections={{ tools: 'expanded', thinking: 'hidden', subagents: 'hidden', activity: 'hidden' }}
      />
    )
    const frame = lastFrame()
    expect(frame).not.toContain('analyzing tool output')
    expect(frame).toContain('Fs Read')
  })

  it('耗时文本保留在行内（splitToolDuration 仍生效）', () => {
    const { lastFrame } = render(
      <ToolTrail
        t={DEFAULT_THEME}
        trail={['Fs Read("x.txt") (0.0s) :: ok ✓']}
        detailsMode="expanded"
        sections={{ tools: 'expanded', thinking: 'hidden', subagents: 'hidden', activity: 'hidden' }}
      />
    )
    expect(lastFrame()).toContain('(0.0s)')
  })

  it('live 工具行（进行中）渲染 Spinner 前缀与实时耗时', () => {
    const { lastFrame } = render(
      <ToolTrail
        busy
        t={DEFAULT_THEME}
        tools={[{ id: 't1', name: 'Fs Read', startedAt: Date.now() - 3000 }]}
        detailsMode="expanded"
        sections={{ tools: 'expanded', thinking: 'hidden', subagents: 'hidden', activity: 'hidden' }}
      />
    )
    const frame = lastFrame()
    expect(frame).toContain('Fs Read')
    // 实时耗时 ≈3s（渲染毫秒差允许 3.0/3.1s）
    expect(frame).toMatch(/3\.\ds/)
  })
})
