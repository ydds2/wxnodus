// tests/aliases-command.test.ts — /aliases 中文别名总览（2026-09-03 拓展命令可发现性）
// 锁定：registry 三表注册；输出与 ALIASES 单一事实源一致（样例锚点）；空参数不崩。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandBus } from '../src/app/CommandBus.js'
import { createEventBus } from '../src/kernel/events.js'
import { openDB, closeDB } from '../src/store/db.js'
import { createMemory } from '../src/kernel/memory.js'
import { registerCoreHandlers } from '../src/commands/handlers.js'
import { SLASH, COMMAND_DESC, COMMAND_CAT } from '../src/commands/registry.js'
import { ALIASES } from '../src/kernel/commandLevels.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-aliases-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } dirs.length = 0 })

describe('/aliases 中文别名总览', () => {
  it('registry 三表注册', () => {
    expect(SLASH).toContain('/aliases')
    expect(COMMAND_DESC['/aliases']).toContain('中文别名')
    expect(COMMAND_CAT['/aliases']).toBe('◈')
  })

  it('输出与 ALIASES 单一事实源一致（条目数 + 样例锚点）', async () => {
    const d = tmp()
    const bus = createCommandBus()
    const db = openDB(d)
    const ctx = {
      dataDir: d, cwd: process.cwd(), db, mem: createMemory(db), bus: createEventBus(d),
      config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
      agent: { getSessionId: () => 'sA', run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
    } as any
    registerCoreHandlers(bus, ctx)
    const r = await bus.execute('/aliases')
    expect(r.ok).toBe(true)
    expect(r.output).toContain(`中文别名（${Object.keys(ALIASES).length} 条`)
    expect(r.output).toContain('/帮助')
    expect(r.output).toContain('/体检')
    expect(r.output).toContain('/help')
    expect(r.output).toContain('/doctor')
    closeDB(db)
  })
})
