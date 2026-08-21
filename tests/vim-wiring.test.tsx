// tests/vim-wiring.test.tsx — V4 P4-5（A-23）：vim 接线层集成测试
// 盲区补齐：vimCore 纯函数单测已好（vim-core/command/search/visual/textobject），但
// 「按键 → textInput vim 分支 → vimHandleKey → 模态回写」接线层零覆盖——A-23 的
// 「Esc 死代码」正是接线层缺陷（shouldPassThroughToGlobalHandler 含 escape 且先于
// vim 分支——insert→normal 的 Esc 永远到不了 vim），纯函数单测发现不了。
// 驱动方式：真实 @wxnodus/ink renderSync + FakeTty（App 订阅 stdin 'readable'——
// read() 出队 + emit 触发；ink-testing-library 包的是 npm ink，与 @wxnodus/ink
// 上下文错位 useInput 收不到键，故弃用）。
// 时序：孤立 \x1b 是「不完整转义序列」——解析器等后续字节直至超时冲刷才判定 escape
// （App.incompleteEscapeTimer），故 Esc 后需等 ~500ms；普通字符即时送达。
import { EventEmitter } from 'node:events'
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { renderSync } from '@wxnodus/ink'
import { TextInput } from '../src/wxnodus-ui/components/textInput.js'
import { getVimNormalActive, setVimNormalActive } from '../src/wxnodus-ui/config/vimMode.js'

class FakeTty extends EventEmitter {
  chunks: string[] = []
  queue: string[] = []
  columns = 60
  rows = 12
  isTTY = true
  isRaw = false
  readableLength = 0

  ref(): void { /* no-op */ }
  unref(): void { /* no-op */ }
  read(): string | null { return this.queue.shift() ?? null }
  setEncoding(): this { return this }
  setRawMode(mode: boolean): this { this.isRaw = mode; return this }
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    cb?.()
    return true
  }
  /** 测试驱动：入队按键字节并触发 'readable'（App.handleReadable → processInput） */
  send(text: string): void {
    this.queue.push(text)
    this.emit('readable')
  }
}

const settle = (ms = 40) => new Promise<void>(r => setTimeout(r, ms))
/** Esc 的不完整序列超时冲刷等待（App.incompleteEscapeTimer 档位） */
const settleEsc = () => settle(600)

const mk = (vimEnabled: boolean) => {
  const stdout = new FakeTty()
  const stdin = new FakeTty()
  const stderr = new FakeTty()
  let value = ''
  let submitted: string | null = null
  const root = renderSync(React.createElement(TextInput, {
    value: '',
    onChange: (v: string) => { value = v },
    onSubmit: (t: string) => { submitted = t },
    onPaste: () => null,
    vimEnabled,
    columns: 60,
  }), {
    exitOnCtrlC: false,
    patchConsole: false,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  return {
    stdin,
    stdout,
    get value() { return value },
    get submitted() { return submitted },
    async unmount() { root.unmount(); await settle(); },
  }
}

afterEach(() => { setVimNormalActive(false) })

describe('V4 P4-5 vim 接线层（A-23）', () => {
  it('Esc 到达 vim：insert → NORMAL（旗标同步 + -- NORMAL -- 渲染）——pass-through 不再吞 Esc（死代码根因回归锁）', async () => {
    const t = mk(true)
    await settle()
    expect(getVimNormalActive()).toBe(false) // 初始 insert
    t.stdin.send('a')
    await settle()
    t.stdin.send('\x1b') // Esc（不完整序列——等超时冲刷判定）
    await settleEsc()
    // Esc 消费后模态切 NORMAL——全局旗标同步（useKeyBindings 双 Esc 门控消费面）
    expect(getVimNormalActive()).toBe(true)
    // 渲染面：NORMAL 前缀进帧
    expect(t.stdout.chunks.join('')).toContain('NORMAL')
    await t.unmount()
  })

  it('NORMAL 模态键生效：x 删字符（vimHandleKey 路径，非普通文本输入）', async () => {
    const t = mk(true)
    await settle()
    t.stdin.send('h')
    await settle()
    t.stdin.send('i')
    await settle()
    t.stdin.send('\x1b') // → NORMAL
    await settleEsc()
    expect(getVimNormalActive()).toBe(true)
    t.stdin.send('x') // NORMAL: 删光标处字符（hi → h）
    await settle()
    expect(t.value).toBe('h')
    await t.unmount()
  })

  it('NORMAL 下 i 回 insert，后续输入恢复普通文本', async () => {
    const t = mk(true)
    await settle()
    t.stdin.send('a')
    await settle()
    t.stdin.send('\x1b')
    await settleEsc()
    expect(getVimNormalActive()).toBe(true)
    t.stdin.send('i') // → insert
    await settle()
    expect(getVimNormalActive()).toBe(false)
    t.stdin.send('b') // insert 下 b 是普通输入；真 vim 语义：Esc 后光标坐在 'a' 上，
    await settle()    // i 在其前插入 → 'ba'（而非追加 'ab'）
    expect(t.value).toBe('ba')
    await t.unmount()
  })

  it('vim 关闭时 Esc 不进 vim 分支（旗标保持 false——非 vim 用户零变化）', async () => {
    const t = mk(false)
    await settle()
    t.stdin.send('a')
    await settle()
    t.stdin.send('\x1b')
    await settleEsc()
    expect(getVimNormalActive()).toBe(false)
    await t.unmount()
  })
})
