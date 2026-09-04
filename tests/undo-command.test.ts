// tests/undo-command.test.ts — /undo 命令（原型 28 回滚时间线的命令面——规范实现 src/commands/ext/sessionCommands.ts）：
// 软归档回滚（历史存档仍可检索）+ 自动 checkpoint + /undo fs 文件级 + /undo list
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandBus } from '../src/app/CommandBus.js'
import { openDB, closeDB } from '../src/store/db.js'
import { createEventBus } from '../src/kernel/events.js'
import { createMemory } from '../src/kernel/memory.js'
import { registerCoreHandlers } from '../src/commands/handlers.js'
import { registerExtHandlers } from '../src/commands/handlersExt.js'
import { snapshotFile, listShadows } from '../src/kernel/undoShadows.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-undo-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } })

function harness(d: string, sessionId = 'default') {
  const bus = createCommandBus()
  const db = openDB(d)
  const evBus = createEventBus(d)
  const mem = createMemory(db)
  const ctx = {
    dataDir: d,
    cwd: process.cwd(),
    db, mem, bus: evBus,
    config: {
      get: () => ({ apiKeyEnc: null, baseURL: 'https://mock' }),
      getKey: () => undefined,
      setKey: () => undefined,
    },
    agent: { getSessionId: () => sessionId },
  } as any
  // 真实 CLI 装配顺序：core → ext（ext 的 /undo 为规范实现——重复注册即覆盖）
  registerCoreHandlers(bus, ctx)
  registerExtHandlers(bus, ctx)
  return { bus, db, evBus }
}

const insertMsg = (db: any, sid: string, runNo: number, role: 'user' | 'assistant', content: string, ts: number) => {
  db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, 't', ?, ?) ON CONFLICT(id) DO NOTHING`).run(sid, ts, ts)
  db.prepare(`INSERT INTO messages (session_id, role, content, ts, run_no) VALUES (?,?,?,?,?)`).run(sid, role, content, ts, runNo)
}

describe('/undo 软归档回滚（原型 28 命令面 · 规范实现）', () => {
  it('/undo 1：消息软归档（archived=1 仍可检索）+ 自动 checkpoint 快照', async () => {
    const d = tmp()
    const { bus, db } = harness(d)
    const now = Date.now()
    insertMsg(db, 'default', 1, 'user', '第一轮需求', now - 60_000)
    insertMsg(db, 'default', 1, 'assistant', '第一轮回答', now - 55_000)
    insertMsg(db, 'default', 2, 'user', '第二轮改文件', now - 30_000)
    insertMsg(db, 'default', 2, 'assistant', '第二轮回答', now - 25_000)

    const r = await bus.execute('/undo 1')
    expect(r.ok).toBe(true)
    expect(String(r.output)).toContain('已撤销 1 轮')
    // 软归档而非删除：消息仍在（archived=1）
    const active = db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id='default' AND archived=0`).get() as { c: number }
    expect(active.c).toBe(2) // 第一轮保留在工作窗口
    const archived = db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id='default' AND archived=1`).get() as { c: number }
    expect(archived.c).toBe(2) // 第二轮入历史存档（仍可检索——recall 不丢）
    // 自动 checkpoint（回滚前快照可 restore）
    const cps = db.prepare(`SELECT COUNT(*) c FROM checkpoints WHERE session_id='default'`).get() as { c: number }
    expect(cps.c).toBeGreaterThanOrEqual(1)
    closeDB(db)
  })

  it('/undo list：列出可撤销轮次（新的在前）', async () => {
    const d = tmp()
    const { bus, db } = harness(d)
    const now = Date.now()
    insertMsg(db, 'default', 1, 'user', '第一条', now - 30_000)
    insertMsg(db, 'default', 2, 'user', '第二条', now - 10_000)
    const r = await bus.execute('/undo list')
    expect(String(r.output)).toContain('可撤销轮次')
    closeDB(db)
  })

  it('/undo fs：文件快照 list + restore（编辑前自动快照）', async () => {
    const d = tmp()
    const { bus } = harness(d)
    const file = join(d, 'a.txt')
    writeFileSync(file, 'old', 'utf8')
    snapshotFile(d, file, 'old')
    writeFileSync(file, 'new', 'utf8')
    const list = await bus.execute('/undo fs list')
    expect(String(list.output)).toContain('文件快照')
    const rest = await bus.execute('/undo fs restore 1')
    expect(String(rest.output)).toContain('已恢复')
    expect(readFileSync(file, 'utf8')).toBe('old')
  })

  it('无可撤销消息：诚实返回（不空转）', async () => {
    const d = tmp()
    const { bus, db } = harness(d)
    const r = await bus.execute('/undo 1')
    expect(r.ok).toBe(true)
    expect(String(r.output)).toContain('没有可撤销')
    closeDB(db)
  })
})
