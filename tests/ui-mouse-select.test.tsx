// tests/ui-mouse-select.test.tsx — A19 鼠标点选辅助：消息选中快照/状态条提示/输入框多击选词选行
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'

import { StatusRule } from '../src/wxnodus-ui/components/appChrome.js'
import {
  MessageLine,
  messageClickIntent,
  messageMultiClickIntent
} from '../src/wxnodus-ui/components/messageLine.js'
import { lineBoundsAt, wordBoundsAt } from '../src/wxnodus-ui/components/textInput.js'
import { ZERO } from '../src/wxnodus-ui/domain/usage.js'
import {
  clearSelectedMessage,
  getUiState,
  resetUiState,
  selectMessage,
  showSelectionHint
} from '../src/wxnodus-ui/runtime/viewStore.js'
import { DEFAULT_THEME } from '../src/wxnodus-ui/theme.js'

beforeEach(() => {
  resetUiState()
})

afterEach(() => {
  vi.useRealTimers()
  resetUiState()
})

describe('A19 viewStore：消息选中快照与提示', () => {
  it('selectMessage 快照 key/text/role（点击时固定，流式更新不影响副本）', () => {
    selectMessage('k1', '整条消息文本', 'assistant')
    expect(getUiState().selectedMessage).toEqual({ key: 'k1', text: '整条消息文本', role: 'assistant' })
  })

  it('clearSelectedMessage 取消选中；无选中时幂等', () => {
    selectMessage('k1', 't', 'user')
    clearSelectedMessage()
    expect(getUiState().selectedMessage).toBeNull()
    expect(() => clearSelectedMessage()).not.toThrow()
  })

  it('showSelectionHint 显示并 3s 自动清除', () => {
    vi.useFakeTimers()
    showSelectionHint('✓ 已复制 5 字符')
    expect(getUiState().selectionHint).toBe('✓ 已复制 5 字符')
    vi.advanceTimersByTime(3001)
    expect(getUiState().selectionHint).toBeNull()
  })

  it('连续 showSelectionHint 重置计时（只显示最新提示）', () => {
    vi.useFakeTimers()
    showSelectionHint('第一条')
    vi.advanceTimersByTime(2000)
    showSelectionHint('第二条')
    vi.advanceTimersByTime(2000)
    // 第一条的 timer 已失效——第二条还显示着（还有 1s）
    expect(getUiState().selectionHint).toBe('第二条')
    vi.advanceTimersByTime(1100)
    expect(getUiState().selectionHint).toBeNull()
  })
})

describe('A19 输入框多击：双击选词/三击选行/四击全选', () => {
  it('双击词内 → 词边界（连字符/点/斜杠为词内字符）', () => {
    expect(wordBoundsAt('hello world', 1)).toEqual({ start: 0, end: 5 })
    expect(wordBoundsAt('foo-bar', 3)).toEqual({ start: 0, end: 7 })
    expect(wordBoundsAt('a.b/c', 2)).toEqual({ start: 0, end: 5 })
    expect(wordBoundsAt('带_下划线词', 2)).toEqual({ start: 0, end: 6 })
  })

  it('双击空白不产生选区（单格）', () => {
    // 'hello world'：空格在 index 5
    expect(wordBoundsAt('hello world', 5)).toEqual({ start: 5, end: 5 })
    expect(wordBoundsAt('a  b', 2)).toEqual({ start: 2, end: 2 })
  })

  it('双击标点段只选标点本身', () => {
    expect(wordBoundsAt('a,b', 1)).toEqual({ start: 1, end: 2 })
    expect(wordBoundsAt('你好，世界', 2)).toEqual({ start: 2, end: 3 })
  })

  it('中文连续串视为词（\\p{L} 覆盖汉字）', () => {
    expect(wordBoundsAt('你好世界', 1)).toEqual({ start: 0, end: 4 })
  })

  it('offset 越界夹取（末端空白视为单格）', () => {
    expect(wordBoundsAt('word', 99)).toEqual({ start: 4, end: 4 })
    expect(wordBoundsAt('word', -1)).toEqual({ start: 0, end: 4 })
  })

  it('三击 → 当前 \\n 逻辑行', () => {
    // '第一行\n第二行\n第三行'：换行符在 index 3 与 7
    const v = '第一行\n第二行\n第三行'
    expect(lineBoundsAt(v, 0)).toEqual({ start: 0, end: 3 })
    expect(lineBoundsAt(v, 5)).toEqual({ start: 4, end: 7 })
    expect(lineBoundsAt(v, 9)).toEqual({ start: 8, end: 11 })
    // 行内点击归属本行；换行符位置归属上一行
    expect(lineBoundsAt(v, 2)).toEqual({ start: 0, end: 3 })
    expect(lineBoundsAt(v, 3)).toEqual({ start: 0, end: 3 })
    expect(lineBoundsAt(v, 4)).toEqual({ start: 4, end: 7 })
  })

  it('空串/单行三击安全', () => {
    expect(lineBoundsAt('', 0)).toEqual({ start: 0, end: 0 })
    expect(lineBoundsAt('solo', 2)).toEqual({ start: 0, end: 4 })
  })
})

describe('A19 消息行鼠标意图（messageClickIntent / messageMultiClickIntent）', () => {
  const msg = { role: 'assistant' as const, text: 'hello' }

  it('空白格点击 → clear（取消选中）', () => {
    expect(messageClickIntent({ cellIsBlank: true }, 'k1', msg)).toEqual({ type: 'clear' })
  })

  it('内容区点击 → select（快照 key/text/role）', () => {
    expect(messageClickIntent({ cellIsBlank: false }, 'k1', msg)).toEqual({
      type: 'select',
      key: 'k1',
      text: 'hello',
      role: 'assistant'
    })
  })

  it('无 msgKey（不可点消息）→ none', () => {
    expect(messageClickIntent({ cellIsBlank: false }, undefined, msg)).toEqual({ type: 'none' })
  })

  it('双击（count=2 且可点）→ 复制；三击/单击 → 不复制', () => {
    expect(messageMultiClickIntent({ clickCount: 2 }, 'k1')).toBe(true)
    expect(messageMultiClickIntent({ clickCount: 3 }, 'k1')).toBe(false)
    expect(messageMultiClickIntent({ clickCount: 1 }, 'k1')).toBe(false)
    expect(messageMultiClickIntent({ clickCount: 2 }, undefined)).toBe(false)
  })

  it('MessageLine 渲染选中态不崩（选中 key 匹配时渲染路径走 selectionBg 分支）', () => {
    selectMessage('k1', 'hello', 'assistant')
    const { lastFrame } = render(<MessageLine cols={80} msg={msg} msgKey="k1" t={DEFAULT_THEME} />)
    expect(lastFrame()).toContain('hello')
    resetUiState()
    const plain = render(<MessageLine cols={80} msg={msg} msgKey="k1" t={DEFAULT_THEME} />)
    expect(plain.lastFrame()).toContain('hello')
  })
})

describe('A19 状态条提示（StatusRule）', () => {
  const base = {
    busy: false,
    cols: 120,
    cwdLabel: 'test',
    liveSessionCount: 0,
    model: 'deepseek',
    showCost: false,
    status: 'idle',
    statusColor: '#00E5FF',
    t: DEFAULT_THEME,
    usage: ZERO
  }

  it('selectionHint 显示在状态条', () => {
    const { lastFrame } = render(<StatusRule {...base} selectionHint="单击选中 · 双击复制" />)
    expect(lastFrame()).toContain('单击选中')
  })

  it('selectionHint 优先于 notice', () => {
    const { lastFrame } = render(<StatusRule {...base} selectionHint="选中提示" notice={{ text: '通知内容' }} />)
    expect(lastFrame()).toContain('选中提示')
    expect(lastFrame()).not.toContain('通知内容')
  })

  it('无 hint 时正常显示 status 与 notice', () => {
    const { lastFrame } = render(<StatusRule {...base} notice={{ text: '通知内容' }} />)
    expect(lastFrame()).toContain('通知内容')
    expect(lastFrame()).not.toContain('选中提示')
  })
})
