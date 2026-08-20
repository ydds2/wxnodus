import { EventEmitter } from 'events'
import React, { useState } from 'react'
import { describe, expect, it } from 'vitest'

import ScrollBox, { type ScrollBoxHandle } from './components/ScrollBox.js'
import Text from './components/Text.js'
import Ink from './ink.js'

class FakeTty extends EventEmitter {
  chunks: string[] = []
  columns = 40
  rows = 12
  isTTY = true
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    cb?.()
    return true
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20))

// 2026-08-19 回归：用户向上翻看时不得被强制拉底（原缺陷——手动滚动后
// 虚拟化 clamp 追赶使 scrollTop 瞬间回到 max，下一帧内容增长即被误判
// 「回到底部」而重贴底）。三组断言：断 sticky 后位置保持 / 宽限期内
// 不重贴底 / 显式 scrollToBottom 仍然有效。
describe('ScrollBox sticky-break + repin grace', () => {
  const setup = async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()
    const ink = new Ink({
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    ink.setAltScreenActive(true)

    let grow!: (n: number) => void
    const handleRef = React.createRef<ScrollBoxHandle>()

    function App() {
      const [n, setN] = useState(30)
      grow = setN
      return React.createElement(
        ScrollBox,
        { ref: handleRef, stickyScroll: true, height: 8, flexDirection: 'column' },
        Array.from({ length: n }, (_, i) => React.createElement(Text, { key: i }, `row ${i}`))
      )
    }

    ink.render(React.createElement(App))
    ink.onRender()
    await tick()
    ink.onRender()
    await tick()

    return { grow, handleRef, ink, render: async () => { ink.onRender(); await tick(); ink.onRender() } }
  }

  it('keeps manual position after content growth', async () => {
    const { grow, handleRef, ink, render } = await setup()
    const atBottom = handleRef.current!.getScrollTop()
    expect(handleRef.current!.isSticky()).toBe(true)
    expect(atBottom).toBeGreaterThan(0)

    handleRef.current!.scrollTo(atBottom - 5)
    await render()

    const afterManual = handleRef.current!.getScrollTop()
    expect(afterManual).toBe(atBottom - 5)
    expect(handleRef.current!.isSticky()).toBe(false)

    grow(40)
    await render()

    const finalTop = handleRef.current!.getScrollTop()
    const max = handleRef.current!.getScrollHeight() - handleRef.current!.getViewportHeight()
    expect(finalTop).toBe(afterManual)
    expect(finalTop).toBeLessThan(max)

    ink.unmount()
  })

  it('suppresses re-pin within grace after manual scroll', async () => {
    const { grow, handleRef, ink, render } = await setup()
    const atBottom = handleRef.current!.getScrollTop()

    // 手动滚到（旧）底部——sticky 显式断掉；随后内容立刻增长：
    // 无宽限时 scrollTop===prevMax 会触发位置跟随重贴底
    handleRef.current!.scrollTo(atBottom)
    grow(40)
    await render()

    expect(handleRef.current!.isSticky()).toBe(false)
    expect(handleRef.current!.getScrollTop()).toBe(atBottom)

    ink.unmount()
  })

  it('explicit scrollToBottom still re-pins', async () => {
    const { grow, handleRef, ink, render } = await setup()
    const atBottom = handleRef.current!.getScrollTop()

    handleRef.current!.scrollTo(atBottom - 5)
    grow(40)
    await render()
    expect(handleRef.current!.isSticky()).toBe(false)

    handleRef.current!.scrollToBottom()
    await render()

    expect(handleRef.current!.isSticky()).toBe(true)
    expect(handleRef.current!.getScrollTop()).toBe(
      handleRef.current!.getScrollHeight() - handleRef.current!.getViewportHeight()
    )

    ink.unmount()
  })
})
