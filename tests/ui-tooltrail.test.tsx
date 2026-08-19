// tests/ui-tooltrail.test.tsx — 2026-08-19 全面替换：PeerToolTrail（对标 Claude Code 家族
// 输出格式）——单行「• Name(短参)」+ dim 结果；无 ✓/✗ 装饰、无时长、过渡行丢弃
import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'

import { PeerToolTrail } from '../src/wxnodus-ui/components/peerTrail.js'
import { DEFAULT_THEME } from '../src/wxnodus-ui/theme.js'

describe('PeerToolTrail（Claude Code 同族格式）', () => {
  it('完成调用渲染单行：工具名可见、无 ✓ 装饰、无时长', () => {
    const { lastFrame } = render(
      <PeerToolTrail t={DEFAULT_THEME} trail={['Fs Read("x.txt") (0.0s) :: 读取完成 ✓']} />
    )
    const frame = lastFrame()
    expect(frame).toContain('Fs Read')
    expect(frame).not.toContain('✓')
    expect(frame).not.toContain('(0.0s)')
  })

  it('结果详情以 dim 缩进展示（detail 可见）', () => {
    const { lastFrame } = render(
      <PeerToolTrail t={DEFAULT_THEME} trail={['Fs Read("x.txt") (0.0s) :: 读取完成 ✓']} />
    )
    expect(lastFrame()).toContain('读取完成')
  })

  it('过渡行 analyzing tool output… 不再渲染', () => {
    const { lastFrame } = render(
      <PeerToolTrail t={DEFAULT_THEME} trail={['analyzing tool output…', 'Fs Read("x") (0.5s) :: ok ✓']} />
    )
    const frame = lastFrame()
    expect(frame).not.toContain('analyzing tool output')
    expect(frame).toContain('Fs Read')
  })

  it('进行中调用渲染单行（名称 + 短参），无耗时', () => {
    const { lastFrame } = render(
      <PeerToolTrail t={DEFAULT_THEME} tools={[{ id: 't1', name: 'Bash', startedAt: Date.now(), context: 'npm test' }]} />
    )
    const frame = lastFrame()
    expect(frame).toContain('Bash')
    expect(frame).toContain('npm test')
    expect(frame).not.toMatch(/\(\d+\.\ds\)/)
  })

  it('失败调用渲染失败行（✗ 标记被解析但只以错误着色呈现，无装饰符号）', () => {
    const { lastFrame } = render(
      <PeerToolTrail t={DEFAULT_THEME} trail={['Bash("ls") (1.2s) :: 文件不存在 ✗']} />
    )
    const frame = lastFrame()
    expect(frame).toContain('Bash')
    expect(frame).toContain('文件不存在')
    expect(frame).not.toContain('✗')
  })

  it('长命令行有界截断（不整串入行）', () => {
    const long = 'curl.exe -sL https://example.com/' + 'x'.repeat(120) + ' -o out.md'
    const { lastFrame } = render(<PeerToolTrail t={DEFAULT_THEME} trail={[`Bash("${long}") (2.0s) ✓`]} />)
    const frame = lastFrame()
    expect(frame).toContain('Bash')
    expect(frame).toContain('…')
    // 长串中段不出现（64 字符截断生效）
    expect(frame).not.toContain('x'.repeat(60))
    expect(frame).not.toContain('(2.0s)')
  })

  it('空轨迹渲染空（无残留行）', () => {
    const { lastFrame } = render(<PeerToolTrail t={DEFAULT_THEME} trail={[]} />)
    expect(lastFrame()?.trim() ?? '').toBe('')
  })
})
