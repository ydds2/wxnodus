// tests/kernel-memory-inbox.test.ts — 波 2 ⑪：AI 记忆收件箱（gemini .inbox 对标）
// 批准流：memory_write（memoryInbox=true）→ pending → apply 生效（modern 记忆层）→ undo 按记录撤销；
// discard 丢弃不入库；默认关直写零漂移。
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDB, openDB } from '../src/store/db.js'
import { coreTools } from '../src/kernel/tools.js'
import { ensureMemoryInbox, inboxAdd, inboxGet, inboxList, inboxMark } from '../src/kernel/memoryInbox.js'
import { openMemoryRepository } from '../src/infrastructure/sqlite/memoryRepository.js'
import { createMemoryService } from '../src/application/memoryService.js'

const dir = mkdtempSync(join(tmpdir(), 'wxn-inbox-'))
const db = openDB(dir)
const sid = 's1'

afterAll(() => {
  try { closeDB(db) } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

const makeCtx = (settings: Record<string, unknown>) =>
  ({ db, dataDir: dir, sessionId: sid, getSettings: () => settings } as any)

describe('memoryInbox 表服务（纯端口）', () => {
  it('add → pending 列表 → 状态流转（applied 记 record_id / reverted）', () => {
    const row = inboxAdd(db, sid, '候选记忆A', 'in-1', 1000)
    expect(row.status).toBe('pending')
    expect(inboxList(db, sid, 'pending').map(r => r.id)).toContain('in-1')
    expect(inboxMark(db, 'in-1', 'applied', 'mem-9')).toBe(true)
    expect(inboxGet(db, 'in-1')!.memory_record_id).toBe('mem-9')
    expect(inboxMark(db, 'in-1', 'reverted')).toBe(true)
    expect(inboxGet(db, 'in-1')!.status).toBe('reverted')
    expect(inboxMark(db, 'no-such-id', 'discarded')).toBe(false)
  })

  it('discard 后不在 pending 列表（未进记忆库）', () => {
    inboxAdd(db, sid, '候选记忆B', 'in-2', 2000)
    inboxMark(db, 'in-2', 'discarded')
    expect(inboxList(db, sid, 'pending').map(r => r.id)).not.toContain('in-2')
    expect(inboxGet(db, 'in-2')!.status).toBe('discarded')
  })
})

describe('memory_write 收件箱路由（settings.memoryInbox=true）', () => {
  it('开启 → 写入入箱待审（不进 modern 记忆层）；apply 后 search 可命中；undo 后删除', async () => {
    const tools = coreTools()
    const t = tools.memory_write!
    const tag = `收件箱验证${Date.now()}`
    const out = await t.run({ content: `${tag}：候选偏好` }, makeCtx({ memoryInbox: true }))
    expect(out).toContain('已入收件箱')
    expect(out).toMatch(/id=inbox-/)
    const id = out.match(/id=(inbox-[a-z0-9-]+)/)![1]!

    // 待审列表可见
    expect(inboxList(db, sid, 'pending').some(r => r.id === id)).toBe(true)

    // 未批准 → modern 检索不到（审阅门生效）
    const svc = createMemoryService(openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now()}` }), { sessionId: sid })
    let hits = svc.search({ text: tag, limit: 5 })
    expect(hits.ok).toBe(true)
    if (hits.ok) expect(hits.value.some(h => h.record.content.includes('候选偏好'))).toBe(false)

    // 批准 → modern 检索命中
    const applied = svc.append({
      role: 'assistant', content: `${tag}：候选偏好`, salience: 0.5,
      retention: { class: 'session' as const, retainUntil: null },
      provenance: {
        sourceType: 'tool', sourceId: sid, sourceUri: undefined, capturedAt: new Date().toISOString(),
        actorId: sid, correlationId: 'memory_inbox_apply', policySnapshotId: 'inbox', sourceTrust: 1,
      },
    })
    expect(applied.ok).toBe(true)
    if (applied.ok) {
      inboxMark(db, id, 'applied', applied.value.record.id)
      hits = svc.search({ text: tag, limit: 5 })
      expect(hits.ok).toBe(true)
      if (hits.ok) expect(hits.value.some(h => h.record.content.includes('候选偏好'))).toBe(true)
      // 按记录撤销：删 modern 记录 + 状态 reverted
      const del = svc.delete(applied.value.record.id)
      expect(del.ok).toBe(true)
      inboxMark(db, id, 'reverted')
      expect(inboxGet(db, id)!.status).toBe('reverted')
      const after = svc.search({ text: tag, limit: 5 })
      if (after.ok) expect(after.value.some(h => h.record.content.includes('候选偏好'))).toBe(false)
    }
  })

  it('默认关 → 直写零漂移（结果含「已写入长期记忆」）', async () => {
    const t = coreTools().memory_write!
    const out = await t.run({ content: `直写验证${Date.now()}` }, makeCtx({}))
    expect(out).toContain('已写入长期记忆')
    expect(out).not.toContain('收件箱')
  })
})
