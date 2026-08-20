// tests/terminal-colors-theme.test.ts — B-04 收口：system 主题（OSC 探测解析 + 纯函数生成）
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { parseOscColorResponses, queryTerminalColors } from '../src/wxnodus-ui/lib/terminalColors.js'
import { themeFromTerminalColors, DARK_THEME, LIGHT_THEME } from '../src/wxnodus-ui/theme.js'

describe('parseOscColorResponses', () => {
  it('解析 OSC 10/11 响应（BEL 终止，16 位 rgb）', () => {
    const r = parseOscColorResponses('\x1b]10;rgb:FFFF/0000/0000\x07\x1b]11;rgb:0000/0000/0000\x07')
    expect(r.fg).toBe('#ff0000')
    expect(r.bg).toBe('#000000')
  })

  it('短值归一化（4 位取高字节 / 3 位取前两位 / 1 位翻倍）', () => {
    const r = parseOscColorResponses('\x1b]10;rgb:f/0/0\x07\x1b]11;rgb:abc/def/123\x07')
    expect(r.fg).toBe('#ff0000')
    expect(r.bg).toBe('#abde12')
  })

  it('非 OSC 内容忽略', () => {
    expect(parseOscColorResponses('plain text')).toEqual({})
  })
})

describe('queryTerminalColors（注入流）', () => {
  class FakeInput extends EventEmitter {}

  it('完整响应 → 返回前景/背景；写入查询序列', async () => {
    const input = new FakeInput()
    const writes: string[] = []
    const output = new Writable({ write(chunk, _enc, cb) { writes.push(String(chunk)); cb() } })
    const p = queryTerminalColors(input as never, output as never)
    setTimeout(() => input.emit('data', Buffer.from('\x1b]10;rgb:FFAA/00BB/00CC\x07\x1b]11;rgb:1111/2222/3333\x07')), 10)
    const r = await p
    expect(r).toEqual({ fg: '#ff0000', bg: '#112233' })
    expect(writes.join('')).toContain('\x1b]10;?\x07')
  })

  it('超时无响应 → null（诚实不可用，不伪造）', async () => {
    const input = new FakeInput()
    const output = new Writable({ write(_c, _e, cb) { cb() } })
    const r = await queryTerminalColors(input as never, output as never, 50)
    expect(r).toBeNull()
  })
})

describe('themeFromTerminalColors（纯函数）', () => {
  it('深色背景 → DARK 基底；前景作 primary；语义色继承基底', () => {
    const t = themeFromTerminalColors({ fg: '#FFAA00', bg: '#101010' })
    expect(t.brand).toBe(DARK_THEME.brand)
    expect(t.color.primary).toBe('#FFAA00')
    expect(t.color.ok).toBe(DARK_THEME.color.ok)
    expect(t.color.border).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('浅色背景 → LIGHT 基底', () => {
    const t = themeFromTerminalColors({ fg: '#000000', bg: '#F0F0F0' })
    expect(t.brand).toBe(LIGHT_THEME.brand)
    expect(t.color.primary).toBe('#000000')
    expect(t.color.error).toBe(LIGHT_THEME.color.error)
  })
})
