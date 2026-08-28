// tests/tui-density.test.ts — P2 增强：密度档配置契约（compact/cozy + last-good 守卫）
import { describe, expect, it, beforeEach } from 'vitest'
import { getTuiDensity, setTuiDensity } from '../src/wxnodus-ui/config/density.js'

beforeEach(() => setTuiDensity('compact'))

describe('TUI 密度档', () => {
  it('默认 compact；cozy 切换生效', () => {
    expect(getTuiDensity()).toBe('compact')
    setTuiDensity('cozy')
    expect(getTuiDensity()).toBe('cozy')
  })

  it('非法值忽略（last-good 守卫——误配绝不崩 UI）', () => {
    setTuiDensity('cozy')
    setTuiDensity('ultra-dense')
    setTuiDensity(undefined)
    setTuiDensity(42)
    expect(getTuiDensity()).toBe('cozy')
  })
})
