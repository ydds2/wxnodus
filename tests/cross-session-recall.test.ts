// tests/cross-session-recall.test.ts — 波 3 ⑪ 9→10：本地跨会话语义召回（六家独有——取证：
// aider 仅本地嵌入做 /help 文档 RAG；gemini 云端嵌入；codex/opencode/kimi/crush 纯正则）
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDB, openDB } from '../src/store/db.js'
import { createMemory } from '../src/kernel/memory.js'

const dir = mkdtempSync(join(tmpdir(), 'wxn-xrecall-'))
const db = openDB(dir)
const mem = createMemory(db)

afterAll(() => {
  try { closeDB(db) } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('recallHybrid 跨会话全局召回（sessionId 缺省）', () => {
  it('两会话各自写入 → 全局召回同时命中（FTS bigram 跨会话）', async () => {
    const tag = `跨会话标记${Date.now()}`
    mem.append('sA', 'user', `${tag} 出现在会话 A：偏好严格 TypeScript 模式`)
    mem.append('sB', 'user', `另一段会话 B 也提到 ${tag}：喜欢中文注释`)

    const global = await mem.recallHybrid(tag, { limit: 10 })
    expect(global.length).toBeGreaterThanOrEqual(2)
    const sids = new Set(global.map(h => h.session_id))
    expect(sids.has('sA')).toBe(true)
    expect(sids.has('sB')).toBe(true)

    // 会话限定仍隔离（既有语义不回归）
    const onlyA = await mem.recallHybrid(tag, { limit: 10, sessionId: 'sA' })
    expect(onlyA.some(h => h.session_id === 'sA')).toBe(true)
    expect(onlyA.every(h => h.session_id === 'sA')).toBe(true)
  })

  it('无命中 → 空数组（诚实不编）', async () => {
    const hits = await mem.recallHybrid(`绝不存在的词${Date.now()}xyz`, { limit: 5 })
    expect(hits).toEqual([])
  })
})
