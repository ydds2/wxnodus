// tests/instance-identity.test.ts — T77 实例身份（「网络下载后独一无二」）：
// 首启生成/幂等稳定/确定性代号派生/损坏重建/原子落盘/独立 dataDir 互异
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveCodename, ensureInstanceIdentity } from '../src/kernel/instanceIdentity.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wxn-identity-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('deriveCodename（确定性派生）', () => {
  it('同 instanceId 必得同代号；不同 id 大概率不同', () => {
    const a = deriveCodename('11111111-1111-1111-1111-111111111111')
    const b = deriveCodename('11111111-1111-1111-1111-111111111111')
    expect(a).toEqual(b)
    expect(a.codename).toMatch(/^[A-Za-z]+-[A-Za-z]+ [0-9A-F]{4}$/)
    const c = deriveCodename('22222222-2222-2222-2222-222222222222')
    expect(c.codename).not.toBe(a.codename) // 256×65536 空间下碰撞概率可忽略
  })

  it('serial 恰为 4 位大写十六进制', () => {
    expect(deriveCodename('x'.repeat(36)).serial).toMatch(/^[0-9A-F]{4}$/)
  })
})

describe('ensureInstanceIdentity（首启生成 + 落盘稳定）', () => {
  it('首启生成并原子落盘；二次调用幂等返回同一身份', () => {
    const first = ensureInstanceIdentity(root)
    expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    const onDisk = JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8'))
    expect(onDisk.instanceId).toBe(first.instanceId)
    const second = ensureInstanceIdentity(root)
    expect(second).toEqual(first) // 「独一无二」一旦确立不再漂移
  })

  it('两个独立 dataDir（两份下载）身份互异', () => {
    const other = mkdtempSync(join(tmpdir(), 'wxn-identity-'))
    try {
      const a = ensureInstanceIdentity(root)
      const b = ensureInstanceIdentity(other)
      expect(a.instanceId).not.toBe(b.instanceId)
      expect(a.codename).not.toBe(b.codename)
    } finally { rmSync(other, { recursive: true, force: true }) }
  })

  it('损坏/不完整文件 → 诚实重生成（不假装可读）', () => {
    writeFileSync(join(root, 'instance.json'), '{corrupted', 'utf8')
    const fresh = ensureInstanceIdentity(root)
    expect(fresh.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    // 重生成后落盘可读
    expect(ensureInstanceIdentity(root)).toEqual(fresh)
    // 字段不完整同样重建
    writeFileSync(join(root, 'instance.json'), JSON.stringify({ v: 1, instanceId: 'short' }), 'utf8')
    expect(ensureInstanceIdentity(root).instanceId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('落盘失败（只读/异常目录）→ 进程内仍有身份，不抛错', () => {
    // 指向一个「文件充当目录」的路径——writeFileSync 必然 ENOTDIR
    const fileAsDir = join(root, 'not-a-dir')
    writeFileSync(fileAsDir, 'x', 'utf8')
    const id = ensureInstanceIdentity(join(fileAsDir, 'sub'))
    expect(id.codename).toMatch(/^[A-Za-z]+-[A-Za-z]+ [0-9A-F]{4}$/)
  })

  it('2026-09-03 存量中文代号迁移：instanceId 恒稳定，代号/serial 自洽重派生为英文并落盘', () => {
    const legacy = {
      v: 1,
      instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      codename: '守夜·制图师 FB6B',
      serial: 'FB6B',
      createdAt: 1788357021046,
    }
    writeFileSync(join(root, 'instance.json'), JSON.stringify(legacy), 'utf8')
    const migrated = ensureInstanceIdentity(root)
    expect(migrated.instanceId).toBe(legacy.instanceId) // 真身份不动
    const expected = deriveCodename(legacy.instanceId)
    expect(migrated.codename).toBe(expected.codename)
    expect(migrated.serial).toBe(expected.serial)
    expect(migrated.codename).toMatch(/^[A-Za-z]+-[A-Za-z]+ [0-9A-F]{4}$/)
    expect(migrated.codename).not.toContain('守夜')
    // 迁移已落盘：再读同一英文代号（不再漂移）
    const second = ensureInstanceIdentity(root)
    expect(second.codename).toBe(migrated.codename)
  })
})
