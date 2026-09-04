// tests/tui-palettes.test.ts — 主题系统（原型 31）：四色板结构 / 代理切换 / 回退语义
import { describe, expect, it } from 'vitest'
import {
  DEEP_SPACE, TUI_THEME_NAMES, TUI_THEMES, paletteOf, setTuiTheme, tuiThemeName,
} from '../src/tui/theme.js'

describe('四主题色板（原型 31）', () => {
  it('四主题齐全且 token 完整（颜色均为命名色档/hex——cmd 可渲染）', () => {
    expect(TUI_THEME_NAMES).toEqual(['deepspace', 'dusk', 'contrast', 'mono'])
    for (const name of TUI_THEME_NAMES) {
      const t = TUI_THEMES[name]!.tokens
      for (const key of ['accent', 'violet', 'success', 'warn', 'error', 'fg', 'muted', 'dim', 'line'] as const) {
        const v = t[key]
        expect(typeof v).toBe('string')
        expect(/^(#[0-9a-fA-F]{6}|[a-z]+(Bright)?)$/.test(v)).toBe(true)
      }
      expect(t.spinnerFrames.length).toBe(4)
      expect(t.placeholders.length).toBeGreaterThanOrEqual(4)
      expect(t.line).toBeTruthy() // 三明治边界细线（tips 已随底部瘦身移除——T60/T76 死代码清理）
    }
  })

  it('单色档语义靠字形：accent/violet/success/warn/error 同色（打印友好）', () => {
    const mono = TUI_THEMES.mono!.tokens
    expect(new Set([mono.accent, mono.violet, mono.success, mono.warn, mono.error]).size).toBe(1)
  })
})

describe('DEEP_SPACE 代理：切换即生效（组件零改造）', () => {
  it('setTuiTheme 切换后 DEEP_SPACE 立即指向新色板', () => {
    setTuiTheme('deepspace')
    expect(DEEP_SPACE.accent).toBe(TUI_THEMES.deepspace!.tokens.accent)
    setTuiTheme('dusk')
    expect(DEEP_SPACE.accent).toBe(TUI_THEMES.dusk!.tokens.accent)
    expect(tuiThemeName()).toBe('dusk')
    setTuiTheme('deepspace')
  })

  it('未知名回退深空（零崩溃——持久化脏值防御）', () => {
    expect(setTuiTheme('nope')).toBe('deepspace')
    expect(paletteOf('nope')).toBe(TUI_THEMES.deepspace!.tokens)
    setTuiTheme('deepspace')
  })

  it('paletteOf 取任意色板不污染全局（预览取消零残留）', () => {
    setTuiTheme('deepspace')
    const duskPreview = paletteOf('dusk')
    expect(duskPreview.accent).toBe(TUI_THEMES.dusk!.tokens.accent)
    expect(DEEP_SPACE.accent).toBe(TUI_THEMES.deepspace!.tokens.accent)
  })
})
