import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'ink-testing-library'

import { setRendererCapabilities } from './capabilities.js'
import * as terminalModule from './terminal.js'
import {
  TerminalWriteProvider,
  type TerminalNotification,
  useTerminalNotification
} from './useTerminalNotification.js'

function Probe({ onReady }: { onReady: (notification: TerminalNotification) => void }) {
  onReady(useTerminalNotification())

  return null
}

function mountNotification(writeRaw: (data: string) => void) {
  let notification: TerminalNotification | undefined

  render(
    <TerminalWriteProvider value={writeRaw}>
      <Probe onReady={value => {
        notification = value
      }} />
    </TerminalWriteProvider>
  )

  if (!notification) {
    throw new Error('notification hook did not mount')
  }

  return notification
}

afterEach(() => {
  setRendererCapabilities(null)
  vi.restoreAllMocks()
})

describe('terminal notification capability contract', () => {
  it('suppresses OSC notifications and progress when oscNotify is disabled but keeps BEL', () => {
    const writes: string[] = []
    const notification = mountNotification(data => writes.push(data))
    vi.spyOn(terminalModule, 'isProgressReportingAvailable').mockReturnValue(true)
    setRendererCapabilities({ oscNotify: false })

    notification.notifyITerm2({ message: 'iTerm' })
    notification.notifyKitty({ id: 1, message: 'Kitty', title: 'title' })
    notification.notifyGhostty({ message: 'Ghostty', title: 'title' })
    notification.progress('running', 50)
    notification.notifyBell()

    expect(writes).toEqual(['\u0007'])
  })

  it('emits gated notification sequences and clamps running progress', () => {
    const writes: string[] = []
    const notification = mountNotification(data => writes.push(data))
    vi.spyOn(terminalModule, 'isProgressReportingAvailable').mockReturnValue(true)
    setRendererCapabilities({ oscNotify: true })

    notification.notifyITerm2({ message: 'body', title: 'Title' })
    notification.notifyKitty({ id: 7, message: 'body', title: 'Title' })
    notification.notifyGhostty({ message: 'body', title: 'Title' })
    notification.progress('running', 150)

    expect(writes).toHaveLength(6)
    expect(writes[0]).toContain('Title:\nbody')
    expect(writes[1]).toContain('i=7:d=0:p=title')
    expect(writes[2]).toContain('i=7:p=body')
    expect(writes[3]).toContain('i=7:d=1:a=focus')
    expect(writes[4]).toContain('notify')
    expect(writes[5]).toContain('9;4;1;100')
  })
})
