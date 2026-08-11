// tests/kernel-term.test.ts — A20 后台终端：真实 node-pty 交互会话（spawn/写入/输出/kill）
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTerminalManager } from '../src/kernel/term.js'

const waitFor = (fn: () => boolean, timeoutMs = 12000, intervalMs = 150): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      try {
        if (fn()) {
          resolve()
          return
        }
      } catch { /* 继续轮询 */ }
      if (Date.now() - t0 > timeoutMs) {
        reject(new Error('waitFor 超时'))
        return
      }
      setTimeout(tick, intervalMs)
    }
    tick()
  })

describe('A20 createTerminalManager — 后台终端', () => {
  it('spawn 真实 PTY + 注入输入 + 捕获输出', async () => {
    const tm = createTerminalManager({
      dataDir: mkdtempSync(join(tmpdir(), 'wx-term-')),
      cwd: process.cwd()
    })
    const r = await tm.spawn()
    expect(r.ok).toBe(true)
    const id = r.ok ? r.id : ''
    expect(tm.get(id)).not.toBeNull()

    // 等待 shell 就绪后注入命令
    await new Promise(res => setTimeout(res, 1500))
    const w = tm.write(id, 'echo WXNODUS_TERM_OK\r')
    expect(w.ok).toBe(true)

    await waitFor(() => tm.getLog(id).includes('WXNODUS_TERM_OK'), 15000)
    expect(tm.getLog(id)).toContain('WXNODUS_TERM_OK')

    // kill 后状态 exited
    const k = tm.kill(id)
    expect(k.ok).toBe(true)
    expect(tm.get(id)?.status).toBe('exited')
  })

  it('list 返回会话；不存在 id 报错', async () => {
    const tm = createTerminalManager({
      dataDir: mkdtempSync(join(tmpdir(), 'wx-term-')),
      cwd: process.cwd()
    })
    const r = await tm.spawn()
    expect(r.ok).toBe(true)
    expect(tm.list().length).toBe(1)
    expect(tm.get('nope')).toBeNull()
    const w = tm.write('nope', 'x')
    expect(w.ok).toBe(false)
    expect(tm.getLog('nope')).toBe('')
    if (r.ok) tm.kill(r.id)
  })

  it('已退出会话拒绝写入', async () => {
    const tm = createTerminalManager({
      dataDir: mkdtempSync(join(tmpdir(), 'wx-term-')),
      cwd: process.cwd()
    })
    const r = await tm.spawn()
    expect(r.ok).toBe(true)
    const id = r.ok ? r.id : ''
    await new Promise(res => setTimeout(res, 1200))
    tm.kill(id)
    const w = tm.write(id, 'echo x\r')
    expect(w.ok).toBe(false)
    expect(String(w.error)).toContain('已退出')
  })
})
