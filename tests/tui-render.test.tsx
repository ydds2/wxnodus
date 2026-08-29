// tests/tui-render.test.tsx — 官方 ink 7 组件冒烟：App 首帧必须含三明治结构要素
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/ui/App.js'
import { TuiStore } from '../src/tui/store.js'
import { TuiRuntime } from '../src/tui/runtime.js'

function boot() {
  const store = new TuiStore()
  const runtime = new TuiRuntime({
    store,
    bus: { on: () => () => {} },
    agent: { run: async () => ({ ok: true, text: '', turns: 0 }), abort() {}, steer: () => true },
    commandBus: { execute: async () => ({ ok: true, output: '' }) },
    config: { get: () => ({}) },
    cwd: 'C:/proj',
    gitBranch: () => 'master',
    onRequestExit: () => {},
  })
  runtime.start()
  return { store, runtime }
}

describe('App 组件冒烟（官方 ink 7）', () => {
  it('首帧含品牌头/输入提示符/状态栏', async () => {
    const { store, runtime } = boot()
    const app = render(React.createElement(App, { store, runtime }))
    await new Promise(r => setTimeout(r, 400))
    const frame = app.lastFrame() ?? ''
    console.log('FRAME:', JSON.stringify((frame || '').slice(0, 300)))
    expect(frame).toContain('WXNODUS')
    expect(frame).toContain('[smart]')
    app.unmount()
  }, 10_000)
})
