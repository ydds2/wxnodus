// tests/tui-paste.test.ts — T76 bracketed paste 协议级粘贴（纯状态机 + ink stdin 契约适配）
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createPasteFilter, createPasteStdin } from '../src/tui/paste.js'

const START = '\x1b[200~'
const END = '\x1b[201~'

describe('createPasteFilter（标记剥离 + 块内换行归一）', () => {
  it('标记外字节原样透传（真实回车/方向键语义零影响）', () => {
    const f = createPasteFilter()
    expect(f.push('hello')).toBe('hello')
    expect(f.push('\r')).toBe('\r')
    expect(f.push('\x1b[A')).toBe('\x1b[A')
    expect(f.push('\x03')).toBe('\x03')
    expect(f.inPaste).toBe(false)
  })

  it('粘贴块：\r 与 \r\n 归一为 \n，标记剥离，绝不产生 return 键', () => {
    const f = createPasteFilter()
    expect(f.push(`${START}line1\rline2\r\nline3${END}`)).toBe('line1\nline2\nline3')
    expect(f.inPaste).toBe(false)
    // 块结束后真实回车仍原样
    expect(f.push('\r')).toBe('\r')
  })

  it('标记跨 chunk 分裂（ESC 与后续分离）仍正确识别', () => {
    const f = createPasteFilter()
    expect(f.push('a\x1b')).toBe('a') // 尾部悬挂可能是标记前缀
    expect(f.push('[200~x\ry\x1b[2')).toBe('x\ny') // 前半拼成完整 START；\x1b[2 悬挂
    expect(f.push('01~done')).toBe('done') // 悬挂拼成 END——块闭合
    expect(f.inPaste).toBe(false)
  })

  it('悬挂前缀被证伪（Insert 键 \x1b[2~ 只共享前缀）→ 原样补发绝不吞键', () => {
    const f = createPasteFilter()
    expect(f.push('\x1b[2')).toBe('') // 悬挂（START 前缀）
    expect(f.push('~\r')).toBe('\x1b[2~\r') // 非 START——补发 Insert + 真实回车保留
  })

  it('块内标记后缀分裂（\x1b[20 悬挂再闭合）', () => {
    const f = createPasteFilter()
    f.push(START)
    expect(f.push('text\x1b[20')).toBe('text')
    expect(f.push('1~after')).toBe('after')
    expect(f.inPaste).toBe(false)
  })

  it('连续两次粘贴互不干扰；flush 冲刷悬挂字节不丢失', () => {
    const f = createPasteFilter()
    expect(f.push(`${START}a${END}${START}b${END}`)).toBe('ab')
    expect(f.push('tail\x1b[')).toBe('tail')
    expect(f.flush()).toBe('\x1b[')
  })

  it('空粘贴块（直接 END）与只有标记的流', () => {
    const f = createPasteFilter()
    expect(f.push(`${START}${END}\r`)).toBe('\r')
    const g = createPasteFilter()
    expect(g.push(START)).toBe('')
    expect(g.flush()).toBe('') // 流终止于块内：不残留悬挂
  })
})

describe('createPasteStdin（ink stdin 契约适配 + DECSET 2004）', () => {
  const fakeRawIn = () => {
    const s: any = new PassThrough()
    s.isTTY = true
    s.setRawMode = (mode: boolean) => { s._raw = mode }
    return s as NodeJS.ReadStream & { setRawMode?(mode: boolean): void }
  }

  it('字节级变换经流管道生效（写标记进真 stdin → 变换流读出归一文本）', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    const chunks: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => chunks.push(c))
    raw.write(`${START}paste\rline${END}`)
    raw.write('\r') // 真实回车
    await new Promise(r => setTimeout(r, 50))
    expect(chunks.join('')).toBe('paste\nline\r')
    p.dispose()
  })

  it('单独 Esc 键不被前缀悬挂卡死（25ms 超时冲刷——e2e 实测教训回归）', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    const chunks: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => chunks.push(c))
    raw.write('\x1b') // Esc 键：恰为标记前缀——必须超时下发，不能悬挂
    await new Promise(r => setTimeout(r, 80))
    expect(chunks.join('')).toBe('\x1b')
    // 后续粘贴标记仍正确识别（超时冲刷不影响状态机）
    raw.write(`${START}a\rb${END}`)
    await new Promise(r => setTimeout(r, 50))
    expect(chunks.join('')).toBe('\x1ba\nb')
    p.dispose()
  })

  it('标记前缀真分裂（<25ms 内续到）仍完整识别，超时路径不误吞', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    const chunks: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => chunks.push(c))
    raw.write('\x1b[20')
    await new Promise(r => setTimeout(r, 5)) // 序列分裂但 5ms 内续到
    raw.write('0~x\ry\x1b[201~')
    await new Promise(r => setTimeout(r, 50))
    expect(chunks.join('')).toBe('x\ny')
    p.dispose()
  })

  it('ink 契约委托：isTTY 透传 + setRawMode/ref 委回真 stdin', async () => {
    const raw = fakeRawIn()
    const out = new PassThrough()
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    expect((p.stream as any).isTTY).toBe(true)
    let rawModeSeen = ''
    ;(raw as any).setRawMode = (m: boolean) => { rawModeSeen = m ? 'on' : 'off' }
    let refd = false
    ;(raw as any).ref = () => { refd = true }
    ;(p.stream as any).setRawMode(true)
    ;(p.stream as any).ref()
    expect(rawModeSeen).toBe('on')
    expect(refd).toBe(true)
    p.dispose()
  })

  it('enable/disable 写 DECSET 2004（TTY 时）；dispose 拆管后真 stdin 数据不再进入变换流', async () => {
    const raw = fakeRawIn()
    const writes: string[] = []
    const out = new PassThrough()
    ;(out as any).isTTY = true
    ;(out as any).write = (s: string) => { writes.push(s); return true }
    const p = createPasteStdin(raw, out as unknown as NodeJS.WriteStream)
    p.enable()
    expect(writes).toContain('\x1b[?2004h')
    const seen: string[] = []
    p.stream.setEncoding('utf8')
    p.stream.on('data', (c: string) => seen.push(c))
    p.dispose()
    raw.write('after-dispose')
    await new Promise(r => setTimeout(r, 30))
    expect(seen.join('')).toBe('')
    p.disable()
    expect(writes).toContain('\x1b[?2004l')
  })
})
