// tests/command-bus-abort.test.ts — 命令等待中断（T66）：abort 竞速——长命令 Esc 即回（不再死等）
import { describe, expect, it } from 'vitest'
import { createCommandBus } from '../src/app/CommandBus.js'

describe('CommandBus 中断竞速（长命令 Esc 即回）', () => {
  it('signal 中止于执行中：execute 立即以 cancelled 收口（不等 handler 完成）', async () => {
    const bus = createCommandBus()
    let resolveHandler: ((v: string) => void) | null = null
    bus.register('/slow', () => new Promise<string>(res => { resolveHandler = res }))
    const ac = new AbortController()
    const started = Date.now()
    const p = bus.execute('/slow', { signal: ac.signal })
    await new Promise(r => setTimeout(r, 10)) // 等 handler 进入 pending
    ac.abort()
    const r = await p
    expect(Date.now() - started).toBeLessThan(500) // 立即回——不再死等
    expect(r.ok).toBe(false)
    expect(r.completionStatus).toBe('cancelled')
    expect(r.error).toContain('已取消')
    resolveHandler!('后台完成') // 后台 handler 仍自行收尾（诚实：副作用继续）
    await new Promise(r => setTimeout(r, 10))
  })

  it('无 signal：行为不变（正常 resolve）', async () => {
    const bus = createCommandBus()
    bus.register('/ok', () => '输出')
    const r = await bus.execute('/ok')
    expect(r.ok).toBe(true)
    expect(r.output).toBe('输出')
  })

  it('入口已中止：立即 cancelled（既有语义保持）', async () => {
    const bus = createCommandBus()
    let called = 0
    bus.register('/x', () => { called++; return '不应执行' })
    const ac = new AbortController()
    ac.abort()
    const r = await bus.execute('/x', { signal: ac.signal })
    expect(r.ok).toBe(false)
    expect(r.completionStatus).toBe('cancelled')
    expect(called).toBe(0)
  })
})
