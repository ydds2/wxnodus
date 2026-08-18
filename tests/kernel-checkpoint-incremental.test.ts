// tests/kernel-checkpoint-incremental.test.ts — A-07 快照增量化（kimi _checkpoint 对标：messagesUpTo 上界 vs 全量复制）
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDB, closeDB } from '../src/store/db.js'
import { saveCheckpoint, snapshotMessagesUpTo, messagesAtCheckpoint } from '../src/kernel/checkpoint.js'

const dir = mkdtempSync(join(tmpdir(), 'wxn-ckinc-'))
const db = openDB(dir)
afterAll(() => { closeDB(db); rmSync(dir, { recursive: true, force: true }) })

const insertMsg = (sid: string, content: string) => {
  db.prepare(`INSERT INTO messages (session_id, role, content, archived, ts) VALUES (?, 'user', ?, 0, 1)`).run(sid, content)
  return (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id
}

describe('A-07 快照增量化', () => {
  it('snapshotMessagesUpTo：上界 + 条数', () => {
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', '', 1, 1)`).run()
    insertMsg('s1', 'a')
    const id2 = insertMsg('s1', 'b')
    insertMsg('s1', 'c')
    const up = snapshotMessagesUpTo(db, 's1')
    expect(up.count).toBe(3)
    expect(up.messagesUpTo).toBe(id2 + 1) // 第三条 id
  })

  it('messagesUpTo 重建精确：快照后新增的消息不在重建内（等价旧全量复制）', () => {
    const up = snapshotMessagesUpTo(db, 's1')
    saveCheckpoint(db, 's1', { kind: 'auto', ...up, ts: 1 })
    insertMsg('s1', '快照后新增')
    const row = db.prepare(`SELECT data FROM checkpoints WHERE session_id='s1' ORDER BY id DESC LIMIT 1`).get() as { data: string }
    const msgs = messagesAtCheckpoint(db, 's1', JSON.parse(row.data))!
    expect(msgs).toHaveLength(3)
    expect(msgs.some(m => m.content === '快照后新增')).toBe(false) // 上界截断——快照时点精确
  })

  it('旧形态 messages 数组向后兼容直取', () => {
    const legacy = db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id='s1' ORDER BY id`).all()
    const msgs = messagesAtCheckpoint(db, 's1', { kind: 'manual', messages: legacy })!
    expect(msgs).toHaveLength(legacy.length)
    expect(Array.isArray(messagesAtCheckpoint(db, 's1', { messages: 'bad' }))).toBe(false)
    expect(messagesAtCheckpoint(db, 's1', { kind: 'x' })).toBeNull()
  })
})
