// tests/diff-reviewed.test.ts — /diff mark-reviewed 持久化（2026-08-19 ③ 残留收口）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hunkFingerprint, loadDiffReviewed, markHunkReviewed, isHunkReviewed } from '../src/kernel/diffReviewed.js'
import type { ParsedHunk } from '../src/kernel/hunkApply.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wx-rev-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } })

const hunk = (header: string): ParsedHunk => ({ header, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] })

describe('diff-reviewed 持久化', () => {
  it('指纹确定性：同头同指纹、异头异指纹', () => {
    expect(hunkFingerprint(hunk('@@ -1 +1 @@'))).toBe(hunkFingerprint(hunk('@@ -1 +1 @@')))
    expect(hunkFingerprint(hunk('@@ -1 +1 @@'))).not.toBe(hunkFingerprint(hunk('@@ -2 +2 @@')))
  })

  it('标记 → 落盘 → 重载可见（跨会话持久化）', () => {
    const d = tmp()
    const fp = hunkFingerprint(hunk('@@ -1 +1 @@'))
    markHunkReviewed(d, 'C:/proj/a.js', fp)
    expect(isHunkReviewed(d, 'C:/proj/a.js', fp)).toBe(true)
    // 重新加载（模拟跨会话）
    expect(loadDiffReviewed(d).marks['C:/proj/a.js']?.[fp]).toBe(true)
    // 不同文件/不同指纹不受影响
    expect(isHunkReviewed(d, 'C:/proj/b.js', fp)).toBe(false)
  })

  it('存储文件损坏 → 空 marks（诚实降级不抛）', () => {
    const d = tmp()
    writeFileSync(join(d, 'diff-reviewed.json'), '{ broken', 'utf8')
    expect(loadDiffReviewed(d).marks).toEqual({})
  })
})
