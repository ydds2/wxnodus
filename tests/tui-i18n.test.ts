// tests/tui-i18n.test.ts — C-5 TUI i18n 接线：/lang en 即切即生效（常驻 chrome 双语契约）
// zh 默认输出与既有文案逐字一致（回归由 tui-render 家族锁定）；en 切换后 chrome 全换英文。
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/ui/App.js'
import { TuiStore } from '../src/tui/store.js'
import { TuiRuntime, classifyError } from '../src/tui/runtime.js'
import { initTuiLang, tuiT, tuiLang } from '../src/tui/i18n.js'
import { zhCN } from '../src/application/i18n/catalogs/zh-CN.js'
import { en } from '../src/application/i18n/catalogs/en.js'

const settle = () => new Promise(r => setTimeout(r, 400))

function boot(settings: Record<string, unknown>) {
  const store = new TuiStore()
  const config = { get: (_p: string) => ({ ...settings }) }
  const commandIndex = settings.commandIndex as (() => Array<{ cmd: string; desc: string; cat: string }>) | undefined
  const runtime = new TuiRuntime({
    store,
    bus: { on: () => () => {} },
    agent: { run: async () => ({ ok: true, text: '', turns: 0 }), abort() {}, steer: () => true },
    commandBus: { execute: async () => ({ ok: true, output: '' }) },
    config: config as never,
    cwd: 'C:/proj',
    gitBranch: () => 'master',
    onRequestExit: () => {},
    commandIndex: commandIndex ?? (() => []),
  } as never)
  runtime.start()
  return { store, runtime, config }
}

describe('TUI i18n（C-5：/lang en 真实生效）', () => {
  it('catalog 键集两语言严格一致（tui.* 命名空间）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort())
  })

  it('zh 默认：chrome 中文（欢迎语/空闲/键位提示）', async () => {
    const { store, runtime } = boot({ lang: 'zh-CN' })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('空闲')
    expect(frame).toContain('Enter 发送')
    expect(frame).toContain('就绪')
    app.unmount()
  }, 20_000)

  it('lang=en 即切即生效：同帧渲染读取当前语言（无需重启）', async () => {
    let lang: string = 'zh-CN'
    initTuiLang(() => (lang === 'en' ? 'en' : 'zh-CN'))
    expect(tuiLang()).toBe('zh-CN')
    expect(tuiT('tui.header.idle')).toBe('空闲')
    lang = 'en'
    expect(tuiLang()).toBe('en')
    expect(tuiT('tui.header.idle')).toBe('idle')
    expect(tuiT('tui.composer.queueHint', { n: 2 })).toContain('2 queued')
    expect(tuiT('tui.transcript.hiddenAbove', { n: 7 })).toContain('7 lines above')
    lang = 'zh-CN' // 还原全局态（测试隔离）
  })

  it('en 渲染：App 全帧 chrome 为英文', async () => {
    const { store, runtime } = boot({ lang: 'en' })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('idle')
    expect(frame).toContain('Enter send')
    expect(frame).toContain('ready.')
    expect(frame).not.toContain('空闲')
    expect(frame).not.toContain('Enter 发送')
    app.unmount()
  }, 20_000)

  it('缺键回退中文目录再回退键名（翻译缺失不崩渲染）', () => {
    expect(tuiT('tui.nonexistent.key')).toBe('tui.nonexistent.key')
  })

  it('en 面板渲染：配置面板/帮助页/键位速查全英文（批次ⅩⅩⅤ 第二波覆盖）', async () => {
    const { store, runtime } = boot({ lang: 'en' })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    // 配置面板
    runtime.openConfigPanel()
    await settle()
    let frame = app.lastFrame() ?? ''
    expect(frame).toContain('config')
    expect(frame).toContain('Enter toggles zh-CN↔en instantly')
    expect(frame).not.toContain('配置')
    app.unmount()
  }, 20_000)

  it('en 面板渲染：帮助面板打开即全景索引（全部命令第一眼可见）+ 键位表', async () => {
    const { store, runtime } = boot({ lang: 'en', commandIndex: () => [
      { cmd: '/model', desc: 'model', cat: 'a' }, { cmd: '/theme', desc: 'theme', cat: 'a' },
    ] })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.toggleHelp()
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Full command index') // 2026-09-03：打开即全景索引页（页序 0=全景/1=快捷/2=图谱）
    expect(frame).toContain('/model')
    app.unmount()
  }, 20_000)

  it('en 面板渲染：键位速查面板（keySections 渲染期构建）', async () => {
    const { store, runtime } = boot({ lang: 'en' })
    const app = render(React.createElement(App, { store, runtime }))
    await settle()
    runtime.store.patch({ overlay: { kind: 'keys' } })
    await settle()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('shortcut cheat-sheet')
    expect(frame).toContain('Global')
    expect(frame).toContain('Exit guard')
    expect(frame).not.toContain('快捷键速查')
    app.unmount()
  }, 20_000)

  it('classifyError 出路提示随语言切换（en 给英文出路）', () => {
    let lang = 'en'
    initTuiLang(() => (lang === 'en' ? 'en' : 'zh-CN'))
    expect(classifyError('未配置 API key').hint).toContain('/model configure')
    expect(classifyError('timeout 上游超时').hint).toContain('recall & resend')
    lang = 'zh-CN'
    expect(classifyError('未配置 API key').hint).toContain('/model 配置模型')
  })
})
