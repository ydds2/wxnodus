// tests/keymap-registry.test.ts — UI 重设计 P0-1：键位注册表契约（单一事实源 + 冲突注册期报错 + 跨层诊断）
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_BINDINGS,
  SCOPE_LABEL,
  detectSameScopeConflicts,
  diagnoseKeymap,
  keymapDocs,
  registerBindings,
  specToString,
  type KeyBinding
} from '../src/wxnodus-ui/keymap/registry.js'
import { parseKeySpec } from '../src/wxnodus-ui/config/keymap.js'

describe('specToString（规范字符串归一化）', () => {
  it('修饰键 + 单字符 / 命名键 / 大小写敏感', () => {
    expect(specToString(parseKeySpec('ctrl+k')!)).toBe('ctrl+k')
    expect(specToString(parseKeySpec('escape')!)).toBe('escape')
    expect(specToString(parseKeySpec('G')!)).toBe('G')
    expect(specToString(parseKeySpec('g')!)).toBe('g')
    expect(specToString(parseKeySpec('shift+tab')!)).toBe('shift+tab')
  })
})

describe('registerBindings（注册期冲突检测）', () => {
  it('内置清单零同层冲突（单一事实源自洽）', () => {
    expect(() => registerBindings()).not.toThrow()
    expect(registerBindings().issues).toEqual([])
  })

  it('同 scope 同键 → 注册期 throw（不静默）', () => {
    const bad: KeyBinding[] = [
      { id: 'a', keys: ['ctrl+k'], scope: 'global', action: 'x', help: 'x' },
      { id: 'b', keys: ['ctrl+k'], scope: 'global', action: 'y', help: 'y' }
    ]
    expect(() => registerBindings(bad)).toThrow(/同层键位冲突 1 处/)
  })

  it('跨 scope 同键 → 允许注册（scope 门控是合法设计）', () => {
    const ok: KeyBinding[] = [
      { id: 'a', keys: ['escape'], scope: 'global', action: 'x', help: 'x' },
      { id: 'b', keys: ['escape'], scope: 'pager', action: 'y', help: 'y' }
    ]
    expect(registerBindings(ok).issues).toEqual([])
  })

  it('非法键位规范 → 注册期 throw', () => {
    const bad: KeyBinding[] = [{ id: 'a', keys: ['ctrl+notakey!!'], scope: 'global', action: 'x', help: 'x' }]
    expect(() => registerBindings(bad)).toThrow(/非法键位规范/)
  })

  it('detectSameScopeConflicts 直接调用返回明细（含双方 id 与和弦）', () => {
    const bindings: KeyBinding[] = [
      { id: 'a', keys: ['ctrl+k'], scope: 'global', action: 'x', help: 'x' },
      { id: 'b', keys: ['ctrl+k'], scope: 'global', action: 'y', help: 'y' }
    ]
    const issues = detectSameScopeConflicts(bindings)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ id: 'b', otherId: 'a', chord: 'ctrl+k', scope: 'global' })
  })
})

describe('diagnoseKeymap（跨层双触发诊断——D3 缺陷证据化）', () => {
  it('ctrl+o 双触发（global 模型选择器 × prompt 外部编辑器）如实报告', () => {
    const overlaps = diagnoseKeymap(BUILTIN_BINDINGS)
    const o = overlaps.find(r => r.chord === 'ctrl+o')
    expect(o).toBeDefined()
    expect(o!.ids).toContain('global.model-picker')
    expect(o!.ids).toContain('prompt.editor')
  })

  it('ctrl+r 双触发（global 历史搜索 × vim redo）如实报告', () => {
    const overlaps = diagnoseKeymap(BUILTIN_BINDINGS)
    const r = overlaps.find(x => x.chord === 'ctrl+r')
    expect(r).toBeDefined()
    expect(r!.ids).toContain('global.history')
    expect(r!.ids).toContain('vim.redo')
  })

  it('pager/panel 与 global 的重叠不报（打开时独占输入，scope 门控）', () => {
    const overlaps = diagnoseKeymap(BUILTIN_BINDINGS)
    // escape 在 global×vim 属实报（空闲态双活）；但 pager 层的 escape 不构成报告
    expect(overlaps.some(r => r.scopes.includes('pager'))).toBe(false)
    expect(overlaps.some(r => r.scopes.includes('panel'))).toBe(false)
  })
})

describe('keymapDocs（/help keys 文本生成）', () => {
  it('覆盖全部 scope 分组头 + 全部绑定 id 的动作名', () => {
    const docs = keymapDocs()
    const text = docs.join('\n')

    for (const scope of ['global', 'prompt', 'vim', 'pager', 'panel'] as const) {
      expect(text).toContain(SCOPE_LABEL[scope])
    }

    for (const b of BUILTIN_BINDINGS) {
      expect(text).toContain(b.action)
    }
  })

  it('configurable 动作标注 settings.keymap 覆盖提示', () => {
    const docs = keymapDocs().join('\n')
    expect(docs).toContain('settings.keymap 可覆盖')
  })
})
