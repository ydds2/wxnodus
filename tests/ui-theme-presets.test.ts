// tests/ui-theme-presets.test.ts — B-04 主题预设集（opencode 33 套对标——诚实口径：10 套命名预设）
import { describe, expect, it } from 'vitest'
import { themeByName, themePresetNames, THEME_PRESETS, DARK_THEME, LIGHT_THEME } from '../src/wxnodus-ui/theme.js'

describe('主题预设（themeByName）', () => {
  it('预设名列表：dark/light + 10 命名预设', () => {
    const names = themePresetNames()
    expect(names[0]).toBe('dark')
    expect(names[1]).toBe('light')
    expect(names).toHaveLength(12)
    expect(Object.keys(THEME_PRESETS)).toHaveLength(10)
  })

  it('dark/light → 基底主题；命名预设 → 三元组覆盖且语义色继承基底', () => {
    expect(themeByName('dark')).toBe(DARK_THEME)
    expect(themeByName('light')).toBe(LIGHT_THEME)
    expect(themeByName(' DARK ')).toBe(DARK_THEME) // 大小写/空白宽容
    const nord = themeByName('nord', {})!
    expect(nord.color.primary).toBe('#88C0D0')
    expect(nord.color.accent).toBe('#81A1C1')
    expect(nord.color.border).toBe('#5E81AC')
    expect(nord.color.ok).toBe(DARK_THEME.color.ok) // 语义色继承
    expect(nord.brand).toBe(DARK_THEME.brand) // 品牌段不变
  })

  it('每个预设三元组都与基底不同（真正换肤）；基底 dark', () => {
    for (const [name, p] of Object.entries(THEME_PRESETS)) {
      const t = themeByName(name, {})!
      expect(t.color.primary).toBe(p.trio.primary)
      expect(t.color.primary).not.toBe(DARK_THEME.color.primary)
      expect(p.base).toBe('dark')
    }
  })

  it('未知名 → null（调用方回退 DEFAULT_THEME）', () => {
    expect(themeByName('not-a-theme', {})).toBeNull()
    expect(themeByName('', {})).toBeNull()
  })
})
