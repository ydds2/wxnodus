// capabilities.test.ts — W8-22：渲染器能力集（cmd 档序列/颜色门控）契约
import { EventEmitter } from 'events'
import React from 'react'
import { describe, expect, it } from 'vitest'
import chalk from 'chalk'

import Text from './components/Text.js'
import Ink from './ink.js'
import { getRendererCapabilities, mousePresetFor, setRendererCapabilities } from './capabilities.js'
import { DISABLE_MOUSE_TRACKING } from './termio/dec.js'

class FakeTty extends EventEmitter {
  chunks: string[] = []
  columns = 40
  rows = 8
  isTTY = true
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    cb?.()
    return true
  }
}

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('W8-22 渲染器能力集', () => {
  it('set/get：部分注入与缺省合并；null 重置缺省', () => {
    setRendererCapabilities({ sync2026: false, decstbm: false, truecolor: false, mouse: false })
    expect(getRendererCapabilities()).toMatchObject({ sync2026: false, decstbm: false, truecolor: false, mouse: false, extendedKeys: getRendererCapabilities().extendedKeys })
    setRendererCapabilities(null)
    expect(getRendererCapabilities().truecolor).toBe(true)
  })

  it('truecolor=false → chalk 钳到 level 2（256 色）', () => {
    setRendererCapabilities({ truecolor: false })
    expect(chalk.level).toBe(2)
    setRendererCapabilities(null)
  })

  it('mousePresetFor：mouse=false → 空串；mouse=true 保持既有 DISABLE+preset 语义', () => {
    setRendererCapabilities({ mouse: false })
    expect(mousePresetFor('buttons')).toBe('')
    expect(mousePresetFor('all')).toBe('')
    setRendererCapabilities({ mouse: true })
    expect(mousePresetFor('off')).toBe(DISABLE_MOUSE_TRACKING)
    expect(mousePresetFor('buttons')).toBe(DISABLE_MOUSE_TRACKING + '\x1b[?1000h\x1b[?1002h\x1b[?1006h')
    setRendererCapabilities(null)
  })

  it('帧输出：sync2026=false → 无 BSU/ESU；强制 true → 有 BSU（能力集决定性，与环境无关）', async () => {
    const run = async (cap: { sync2026: boolean }) => {
      const stdout = new FakeTty()
      const stdin = new FakeTty()
      const stderr = new FakeTty()
      const ink = new Ink({
        exitOnCtrlC: false, patchConsole: false,
        stderr: stderr as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        capabilities: cap,
      })
      ink.setAltScreenActive(true)
      ink.render(React.createElement(Text, null, 'hello'))
      ink.onRender()
      await tick()
      ink.unmount()
      return stdout.chunks.join('')
    }
    const off = await run({ sync2026: false })
    expect(off).not.toContain('\x1b[?2026')
    const on = await run({ sync2026: true })
    expect(on).toContain('\x1b[?2026h')
  })

  it('帧输出：truecolor=false → 彩色文本走 256 色（38;5 而非 38;2）', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()
    const ink = new Ink({
      exitOnCtrlC: false, patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      capabilities: { truecolor: false },
    })
    ink.render(React.createElement(Text, { color: '#00E5FF' }, 'cyan'))
    ink.onRender()
    await tick()
    ink.unmount()
    const out = stdout.chunks.join('')
    expect(out).toContain('\x1b[38;5;')
    expect(out).not.toContain('\x1b[38;2;')
  })
})
