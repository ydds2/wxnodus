// tests/tui-mouse-filter.test.ts — ⅩⅩⅩⅢ：SGR 鼠标序列过滤 + 滚轮回调
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createPasteStdin } from '../src/tui/paste.js'

describe('SGR 鼠标序列过滤（ⅩⅩⅩⅢ——修乱码/输入干扰 bug）', () => {
  const fakeRawIn = () => {
    const s: any = new PassThrough()
    s.isTTY = true
    s.setRawMode = () => {}
    return s as NodeJS.ReadStream & { setRawMode?(mode: boolean): void }
  }

  it('SGR 点击序列被剥离——不进 ink（不产生乱码文本）', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    const chunks: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => chunks.push(c))
    // SGR 点击：\x1b[<0;45;12M（左键按下 col=45 row=12）
    raw.write('\x1b[<0;45;12M')
    // SGR 释放：\x1b[<0;45;12m
    raw.write('\x1b[<0;45;12m')
    await new Promise(r => setTimeout(r, 50))
    const all = chunks.join('')
    expect(all).not.toContain('\x1b')
    expect(all).not.toContain('[<')
    expect(all).toBe('') // 全部被过滤
    p.dispose()
  })

  it('SGR 滚轮序列被剥离 + 触发 onWheel 回调（上/下方向）', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const wheels: string[] = []
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream, {
      onWheel: dir => wheels.push(dir),
    })
    const chunks: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => chunks.push(c))
    // 滚轮上：\x1b[<64;10;5M（cb=64 → bit6 滚轮 + bit0=0 → 上）
    raw.write('\x1b[<64;10;5M')
    await new Promise(r => setTimeout(r, 30))
    expect(wheels).toEqual(['up'])
    // 滚轮下：\x1b[<65;10;5M（cb=65 → bit6 滚轮 + bit0=1 → 下）
    raw.write('\x1b[<65;10;5M')
    await new Promise(r => setTimeout(r, 30))
    expect(wheels).toEqual(['up', 'down'])
    // 输出零残留
    expect(chunks.join('')).toBe('')
    p.dispose()
  })

  it('正常键盘输入不受影响（SGR 过滤不误伤）', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    const chunks: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => chunks.push(c))
    raw.write('hello world')
    raw.write('\x1b[A') // ↑ 键
    raw.write('\r') // Enter
    await new Promise(r => setTimeout(r, 50))
    const all = chunks.join('')
    expect(all).toContain('hello world')
    expect(all).toContain('\x1b[A') // 方向键保留
    expect(all).toContain('\r') // Enter 保留
    p.dispose()
  })

  it('SGR 序列与正常文本混合——文本保留、SGR 剥离', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    const chunks: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => chunks.push(c))
    raw.write('type\x1b[<0;1;1Mmore\x1b[<65;5;5Mtext')
    await new Promise(r => setTimeout(r, 50))
    const all = chunks.join('')
    expect(all).toBe('typemoretext') // SGR 剥离、文本保留
    p.dispose()
  })
})
