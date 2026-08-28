import { EventEmitter } from 'events'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { AlternateScreen } from './components/AlternateScreen.js'
import { createRoot } from './root.js'
import { setRendererCapabilities } from './capabilities.js'

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

describe('createRoot renderer capability contract', () => {
  it('forwards host capabilities to the mounted Ink instance', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()
    const root = await createRoot({
      capabilities: {
        mouse: false,
        osc8: false,
        sync2026: false,
        decstbm: false,
        truecolor: false,
        oscNotify: false,
        extendedKeys: false
      },
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    try {
      root.render(
        React.createElement(
          AlternateScreen,
          { mouseTracking: 'all' },
          React.createElement('ink-text', null, 'root')
        )
      )
      await tick()

      expect(stdout.chunks.join('')).not.toContain('\x1b[?1000h')
      expect(stdout.chunks.join('')).not.toContain('\x1b[?1003h')
    } finally {
      root.unmount()
    }
  })
})
