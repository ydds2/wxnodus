// tests/hole-all-command.test.ts — 波 3 ⑪：/hole --all 跨会话语义召回命令面（六家独有）
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandBus } from '../src/app/CommandBus.js'
import { createEventBus } from '../src/kernel/events.js'
import { openDB, closeDB } from '../src/store/db.js'
import { createMemory } from '../src/kernel/memory.js'
import { registerExtHandlers } from '../src/commands/handlersExt.js'
import { registerCoreHandlers } from '../src/commands/handlers.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-holeall-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } dirs.length = 0 })

describe('/hole --all 跨会话语义召回', () => {
  it('两会话写入 → 一次命令同时召回（带会话标识）', async () => {
    const d = tmp()
    const bus = createCommandBus()
    const db = openDB(d)
    const mem = createMemory(db)
    const tag = `跨会话${Date.now()}`
    mem.append('sA', 'user', `${tag} 偏好 TypeScript 严格模式`)
    mem.append('sB', 'user', `${tag} 喜欢中文注释`)
    const ctx = {
      dataDir: d, cwd: process.cwd(), db, mem, bus: createEventBus(d),
      config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
      agent: { getSessionId: () => 'sA', run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
    } as any
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const r = await bus.execute(`/hole --all ${tag}`)
    expect(r.ok).toBe(true)
    expect(r.output).toContain('跨会话语义召回')
    expect(r.output).toContain('sA')
    expect(r.output).toContain('sB')
    closeDB(db)
  })
})
