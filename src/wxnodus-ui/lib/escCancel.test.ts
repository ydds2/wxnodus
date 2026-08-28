// src/wxnodus-ui/lib/escCancel.test.ts — 双 Esc 取消判定器（arm/confirm/超时复位）
import { describe, expect, it } from 'vitest'
import { escCancelNext, ESC_CANCEL_WINDOW_MS } from './escCancel.js'

describe('escCancelNext', () => {
  it('busy 未武装 → arm（武装时间由调用方记录）', () => {
    expect(escCancelNext({ armedAt: null }, { now: 1000, busy: true })).toBe('arm')
  })

  it('武装后窗口内第二次 Esc → confirm（窗口边界含端点）', () => {
    const armedAt = 1000
    expect(escCancelNext({ armedAt }, { now: armedAt + 1, busy: true })).toBe('confirm')
    expect(escCancelNext({ armedAt }, { now: armedAt + ESC_CANCEL_WINDOW_MS, busy: true })).toBe('confirm')
  })

  it('武装后超时 → none（复位，不自动重武装）', () => {
    expect(escCancelNext({ armedAt: 1000 }, { now: 1000 + ESC_CANCEL_WINDOW_MS + 1, busy: true })).toBe('none')
  })

  it('非 busy → none（无论是否武装，Esc 回落常规语义）', () => {
    expect(escCancelNext({ armedAt: null }, { now: 1000, busy: false })).toBe('none')
    expect(escCancelNext({ armedAt: 500 }, { now: 1000, busy: false })).toBe('none')
  })

  it('windowMs 可注入（边界判定不依赖常量值）', () => {
    expect(escCancelNext({ armedAt: 0 }, { now: 200, busy: true, windowMs: 200 })).toBe('confirm')
    expect(escCancelNext({ armedAt: 0 }, { now: 201, busy: true, windowMs: 200 })).toBe('none')
  })
})
