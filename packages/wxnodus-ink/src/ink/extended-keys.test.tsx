import { EventEmitter } from 'events'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { getRendererCapabilities, setRendererCapabilities, type RendererCapabilities } from './capabilities.js'
import { AlternateScreen } from './components/AlternateScreen.js'
import Ink from './ink.js'
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS
} from './termio/csi.js'

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

const makeInk = (capabilities: Partial<RendererCapabilities>) => {
  const stdout = new FakeTty()
  const stdin = new FakeTty()
  const stderr = new FakeTty()
  const ink = new Ink({
    capabilities,
    exitOnCtrlC: false,
    patchConsole: false,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream
  })

  return { ink, stdout }
}

afterEach(() => {
  setRendererCapabilities(null)
})

describe('extended-key capability contract', () => {
  it('does not reassert extended keys when the host disables the capability', () => {
    const { ink, stdout } = makeInk({ extendedKeys: false })
    setRendererCapabilities({ extendedKeys: false })

    ink.reassertTerminalModes()
    ink.exitAlternateScreen()

    const output = stdout.chunks.join('')
    expect(output).not.toContain(ENABLE_KITTY_KEYBOARD)
    expect(output).not.toContain(ENABLE_MODIFY_OTHER_KEYS)
  })

  it('reasserts the balanced extended-key sequence when enabled', () => {
    const { ink, stdout } = makeInk({ extendedKeys: true })
    setRendererCapabilities({ extendedKeys: true })

    ink.reassertTerminalModes()
    ink.exitAlternateScreen()

    const output = stdout.chunks.join('')
    expect(output).toContain(DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS)
  })
})

describe('alternate-screen capability cleanup', () => {
  it('does not enable mouse tracking when the host disables mouse capability', () => {
    const { ink, stdout } = makeInk({ mouse: false, extendedKeys: false })
    setRendererCapabilities({ mouse: false, extendedKeys: false })

    expect(getRendererCapabilities().mouse).toBe(false)

    ink.render(
      React.createElement(
        AlternateScreen,
        { mouseTracking: 'all' },
        React.createElement('ink-text', null, 'screen')
      )
    )
    ink.onRender()

    expect(stdout.chunks.join('')).not.toContain('\x1b[?1000h')
    expect(stdout.chunks.join('')).not.toContain('\x1b[?1003h')

    ink.unmount()
  })
})
