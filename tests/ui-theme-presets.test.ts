// tests/ui-theme-presets.test.ts — B-04 主题预设集（opencode 33 套对标——诚实口径：10 套命名预设）
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { themeByName, themePresetNames, loadUserThemes, THEME_PRESETS, DARK_THEME, LIGHT_THEME } from '../src/wxnodus-ui/theme.js'

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

  it('token 双变体：终端浅色模式 + 预设 light 变体 → LIGHT 基底 + light 三色（opencode dark/light 变体对标）', () => {
    // 深色环境（默认）：solarized 走深色 trio
    const dark = themeByName('solarized', {})!
    expect(dark.color.primary).toBe('#268BD2')
    expect(dark.color.border).toBe('#586E75')
    expect(dark.brand).toBe(DARK_THEME.brand)
    // 浅色环境（WXNODUS_TUI_LIGHT=true）：切 LIGHT 基底 + light 变体三色，语义色继承 LIGHT
    const light = themeByName('solarized', { WXNODUS_TUI_LIGHT: 'true' })!
    expect(light.color.primary).toBe('#268BD2')
    expect(light.color.border).toBe('#93A1A1')
    expect(light.brand).toBe(LIGHT_THEME.brand)
    expect(light.color.ok).toBe(LIGHT_THEME.color.ok)
    // 无 light 变体的预设：浅色环境仍深色基底（诚实——不臆造浅色）
    const nord = themeByName('nord', { WXNODUS_TUI_LIGHT: 'true' })!
    expect(nord.brand).toBe(DARK_THEME.brand)
  })

  it('未知名 → null（调用方回退 DEFAULT_THEME）', () => {
    expect(themeByName('not-a-theme', {})).toBeNull()
    expect(themeByName('', {})).toBeNull()
  })
})

describe('用户主题（dataDir/themes/*.json，opencode themeSource.discover 对标）', () => {
  const dirs: string[] = []
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wx-theme-')); dirs.push(d); return d }
  afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } })

  it('合法文件加载；themeByName 第三参解析用户主题（语义色继承基底）', () => {
    const d = tmp()
    mkdirSync(join(d, 'themes'), { recursive: true })
    writeFileSync(join(d, 'themes', 'ocean.json'), JSON.stringify({ name: 'ocean', base: 'dark', trio: { primary: '#00FFAA', accent: '#00AAFF', border: '#006688' } }), 'utf8')
    const { presets, warnings } = loadUserThemes(d)
    expect(warnings).toEqual([])
    expect(Object.keys(presets)).toEqual(['ocean'])
    const t = themeByName('ocean', {}, presets)!
    expect(t.color.primary).toBe('#00FFAA')
    expect(t.color.accent).toBe('#00AAFF')
    expect(t.color.border).toBe('#006688')
    expect(t.color.ok).toBe(DARK_THEME.color.ok) // 语义色继承
  })

  it('非法文件诚实跳过并收集警告；与内置同名内置优先', () => {
    const d = tmp()
    mkdirSync(join(d, 'themes'), { recursive: true })
    writeFileSync(join(d, 'themes', 'bad-base.json'), JSON.stringify({ name: 'x1', base: 'blue', trio: { primary: '#111111', accent: '#222222', border: '#333333' } }), 'utf8')
    writeFileSync(join(d, 'themes', 'bad-color.json'), JSON.stringify({ name: 'x2', base: 'dark', trio: { primary: 'red', accent: '#222222', border: '#333333' } }), 'utf8')
    writeFileSync(join(d, 'themes', 'bad-json.json'), '{ not json', 'utf8')
    writeFileSync(join(d, 'themes', 'dup-nord.json'), JSON.stringify({ name: 'nord', base: 'dark', trio: { primary: '#111111', accent: '#222222', border: '#333333' } }), 'utf8')
    const { presets, warnings } = loadUserThemes(d)
    expect(Object.keys(presets)).toEqual([]) // 全部非法——零载入
    expect(warnings.length).toBe(4)
    expect(warnings.join(' ')).toContain('base 必须是')
    expect(warnings.join(' ')).toContain('trio 三色')
    expect(warnings.join(' ')).toContain('JSON 解析失败')
    expect(warnings.join(' ')).toContain('内置预设同名')
  })

  it('themes 目录不存在 → 空载入零警告', () => {
    const d = tmp()
    const { presets, warnings } = loadUserThemes(d)
    expect(presets).toEqual({})
    expect(warnings).toEqual([])
  })
})
