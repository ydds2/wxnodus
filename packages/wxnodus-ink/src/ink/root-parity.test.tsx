import { EventEmitter } from 'events'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import Text from './components/Text.js'
import Link from './components/Link.js'
import Ink from './ink.js'
import { setRendererCapabilities } from './capabilities.js'
import { renderSync } from './root.js'

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

afterEach(() => {
  setRendererCapabilities(null)
})

describe('renderer entrypoint capability parity', () => {
  it('renderSync forwards host capabilities to its Ink instance', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()
    const instance = renderSync(React.createElement(Text, { color: '#00E5FF' }, 'sync'), {
      capabilities: {
        truecolor: false,
        sync2026: false,
        osc8: false
      },
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    try {
      await tick()
      const output = stdout.chunks.join('')
      expect(output).not.toContain('\x1b[?2026h')
      expect(output).toContain('\x1b[38;5;')
      expect(output).not.toContain('\x1b[38;2;')
    } finally {
      instance.unmount()
    }
  })

  it('direct Ink render applies the same injected capability gates', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()
    const ink = new Ink({
      capabilities: { truecolor: false, sync2026: false },
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    try {
      ink.render(React.createElement(Text, { color: '#00E5FF' }, 'direct'))
      ink.onRender()
      await tick()
      const output = stdout.chunks.join('')
      expect(output).not.toContain('\x1b[?2026h')
      expect(output).toContain('\x1b[38;5;')
      expect(output).not.toContain('\x1b[38;2;')
    } finally {
      ink.unmount()
    }
  })

  it('default async render preserves the injected capability gates', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()
    const render = (await import('./root.js')).default
    const instance = await render(React.createElement(Text, { color: '#00E5FF' }, 'async'), {
      capabilities: { truecolor: false, sync2026: false },
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    try {
      await tick()
      const output = stdout.chunks.join('')
      expect(output).not.toContain('\x1b[?2026h')
      expect(output).toContain('\x1b[38;5;')
      expect(output).not.toContain('\x1b[38;2;')
    } finally {
      instance.unmount()
    }
  })

  it('keeps internal link metadata while suppressing OSC 8 output', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()
    const clicked: string[] = []
    const ink = new Ink({
      capabilities: { osc8: false, sync2026: false },
      exitOnCtrlC: false,
      patchConsole: false,
      onHyperlinkClick: url => clicked.push(url),
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    try {
      ink.setAltScreenActive(true)
      ink.render(
        React.createElement(Link, { url: 'https://example.com' }, 'link')
      )
      ink.onRender()
      await tick()
      ink.onRender()
      await tick()
      const output = stdout.chunks.join('')
      expect(output).not.toContain('\x1b]8;')
      expect(ink.isAltScreenActive).toBe(true)
      expect(ink.getHyperlinkAt(1, 0)).toBe('https://example.com')
      expect(clicked).toEqual([])
    } finally {
      ink.unmount()
    }
  })
})
