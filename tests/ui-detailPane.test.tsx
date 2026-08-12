// tests/ui-detailPane.test.tsx — A23 双栏布局：右侧详情面板渲染（六标签 + 空态 + 真实 store 数据）
import { render } from 'ink-testing-library'
import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { DetailPane } from '../src/wxnodus-ui/components/detailPane.js'
import { FEATURE_SPOTLIGHTS } from '../src/wxnodus-ui/content/features.js'
import { ZERO } from '../src/wxnodus-ui/domain/usage.js'
import { patchBgState } from '../src/wxnodus-ui/runtime/backgroundStore.js'
import { patchTurnState } from '../src/wxnodus-ui/runtime/flowStore.js'
import { patchUiState } from '../src/wxnodus-ui/runtime/viewStore.js'
import { DEFAULT_THEME } from '../src/wxnodus-ui/theme.js'
import type { SubagentProgress } from '../src/wxnodus-ui/types.js'

const subagent = (over: Partial<SubagentProgress>): SubagentProgress => ({
  depth: 0,
  goal: '分析日志',
  id: 'sa-1',
  index: 0,
  notes: [],
  parentId: null,
  status: 'running',
  taskCount: 1,
  thinking: [],
  toolCount: 0,
  tools: [],
  ...over,
})

beforeEach(() => {
  patchUiState({
    dualPane: true,
    paneTab: 'todo',
    theme: DEFAULT_THEME,
    usage: ZERO,
    info: null,
    busy: false,
    status: '就绪',
    showCost: false,
    sid: null,
  })
  patchTurnState({ todos: [], tools: [], turnTrail: [], subagents: [], todoCollapsed: false })
  patchBgState({ terms: [], jobs: [], cron: [], goal: null })
})

describe('DetailPane — 面板骨架', () => {
  it('渲染六标签 + 关闭钮 + 当前标签高亮', () => {
    const { lastFrame } = render(<DetailPane cols={140} />)
    const frame = lastFrame()

    expect(frame).toContain('⛶ 详情')
    expect(frame).toContain('清单')
    expect(frame).toContain('工具')
    expect(frame).toContain('上下文')
    expect(frame).toContain('子代理')
    expect(frame).toContain('后台')
    expect(frame).toContain('特色')
    expect(frame).toContain('✕')
  })

  it('todo 空态：引导文案（无假数据）', () => {
    const { lastFrame } = render(<DetailPane cols={140} />)

    expect(lastFrame()).toContain('无进行中任务')
  })
})

describe('DetailPane — 清单标签', () => {
  it('渲染实时 todo（in_progress [>] + pending）', () => {
    patchTurnState({
      todos: [
        { id: 't1', content: '理解需求', status: 'in_progress' },
        { id: 't2', content: '制定方案', status: 'pending' },
        { id: 't3', content: '执行实施', status: 'completed' },
      ],
    })
    const { lastFrame } = render(<DetailPane cols={140} />)
    const frame = lastFrame()

    expect(frame).toContain('理解需求')
    expect(frame).toContain('制定方案')
    expect(frame).toContain('[x]') // completed glyph
  })
})

describe('DetailPane — 工具标签', () => {
  it('当前执行工具 + 已完成 trail（✓/✗）', () => {
    patchUiState({ paneTab: 'tools' })
    patchTurnState({
      tools: [{ id: 't-live', name: 'fs_read', context: 'x.txt', startedAt: Date.now() }],
      turnTrail: ['Bash("ls") (1.2s) :: 文件不存在 ✗', 'Fs Read("a.txt") (0.0s) :: 读取完成 ✓'],
    })
    const { lastFrame } = render(<DetailPane cols={140} />)
    const frame = lastFrame()

    expect(frame).toContain('●') // 当前执行
    expect(frame).toContain('✓')
    expect(frame).toContain('✗')
    expect(frame).toContain('Bash')
  })

  it('工具空态：引导文案', () => {
    patchUiState({ paneTab: 'tools' })
    const { lastFrame } = render(<DetailPane cols={140} />)

    expect(lastFrame()).toContain('尚无工具调用')
  })
})

describe('DetailPane — 上下文标签', () => {
  it('token 用量条 + 模型 + 状态文本', () => {
    patchUiState({
      paneTab: 'context',
      usage: { calls: 3, context_max: 128000, context_percent: 25, context_used: 32000, input: 20000, output: 12000, total: 32000 },
      info: { model: 'deepseek-v4', skills: {}, tools: {} },
      busy: true,
      status: '正在读取文件 x.txt',
    })
    const { lastFrame } = render(<DetailPane cols={140} />)
    const frame = lastFrame()

    expect(frame).toContain('25%')
    expect(frame).toContain('deepseek-v4')
    expect(frame).toContain('正在读取文件 x.txt')
    expect(frame).toContain('输入')
  })
})

describe('DetailPane — 子代理标签', () => {
  it('汇总行 + 状态树（glyph + goal）', () => {
    patchUiState({ paneTab: 'subagents' })
    patchTurnState({
      subagents: [
        subagent({ goal: '分析日志' }),
        subagent({ id: 'sa-2', goal: '提取结论', parentId: 'sa-1', depth: 1, status: 'completed' }),
      ],
    })
    const { lastFrame } = render(<DetailPane cols={140} />)
    const frame = lastFrame()

    expect(frame).toContain('分析日志')
    expect(frame).toContain('提取结论')
    expect(frame).toContain('✓') // completed glyph
    expect(frame).toContain('●') // running glyph
  })

  it('子代理空态：引导文案', () => {
    patchUiState({ paneTab: 'subagents' })
    const { lastFrame } = render(<DetailPane cols={140} />)

    expect(lastFrame()).toContain('尚无子代理')
  })
})

describe('DetailPane — 后台标签（A24）', () => {
  it('渲染终端/任务/定时/目标循环四区（真实 $bgState 数据）', () => {
    patchUiState({ paneTab: 'bg' })
    patchBgState({
      terms: [{ id: 't1', shell: 'cmd', cwd: 'C:\\proj', status: 'running', exitCode: null, startedAt: 1 }],
      jobs: [
        { id: 'j1', goal: '后台目标', status: 'running', kind: 'shell', created_at: 1, done_at: null, exit_code: null },
        { id: 'j2', goal: '已完成', status: 'success', kind: 'agent', created_at: 2, done_at: 3, exit_code: 0 },
      ],
      cron: [{ id: 1, schedule: 'every 10m', action: '跑体检', enabled: true, last_run: null }],
      goal: { active: true, done: false, round: 3, maxRounds: 10, text: '正在推进目标' },
    })
    const { lastFrame } = render(<DetailPane cols={140} />)
    const frame = lastFrame()

    expect(frame).toContain('goal 第 3/10 轮')
    expect(frame).toContain('正在推进目标')
    expect(frame).toContain('cmd')
    expect(frame).toContain('后台目标')
    expect(frame).toContain('every 10m')
    expect(frame).toContain('3 项后台活动进行中') // 1 终端 + 1 任务 + 1 goal
  })

  it('后台空态：引导文案（零假数据）', () => {
    patchUiState({ paneTab: 'bg' })
    const { lastFrame } = render(<DetailPane cols={140} />)

    expect(lastFrame()).toContain('暂无后台活动')
  })
})

describe('DetailPane — 特色标签（A24）', () => {
  it('渲染旗舰能力行（含示例命令）', () => {
    patchUiState({ paneTab: 'features' })
    const { lastFrame } = render(<DetailPane cols={140} />)
    const frame = lastFrame()

    for (const f of FEATURE_SPOTLIGHTS) {
      expect(frame).toContain(f.label)
    }
    expect(frame).toContain('/build 做一个待办系统')
    expect(frame).toContain('点击行执行示例命令')
  })
})
