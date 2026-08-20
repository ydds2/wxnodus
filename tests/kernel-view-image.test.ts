// tests/kernel-view-image.test.ts — ③ 波 1：view_image 图片模型输入通道 + fs_edit diff 回显体
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { coreTools } from '../src/kernel/tools.js'

// 1×1 红点 PNG（合法最小图，imageMeta 头解析即可——不整图解码）
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('view_image 工具（kimi read_media.py 对标）', () => {
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-viewimg-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const ctx = () => ({ cwd: dir, dataDir: dir, sessionId: 't', requestSecret: undefined } as any)
  const tool = () => coreTools().view_image!

  it('PNG 载入：尺寸/格式/KB/视觉 token 估算 + extractImages 出 dataUrl part', async () => {
    const p = join(dir, 'a.png')
    writeFileSync(p, PNG_1X1)
    const out = await tool().run({ path: 'a.png' }, ctx())
    expect(out).toContain('图片已载入')
    expect(out).toContain('PNG 1×1')
    expect(out).toContain('视觉 token ≈1')
    const imgs = await tool().extractImages!({ path: 'a.png' }, ctx())
    expect(imgs).toHaveLength(1)
    expect(imgs![0].type).toBe('image_url')
    expect(imgs![0].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('非法文件 → 诚实报错，extractImages 返回 null（不附加垃圾）', async () => {
    const p = join(dir, 'b.txt')
    writeFileSync(p, 'hello')
    const out = await tool().run({ path: 'b.txt' }, ctx())
    expect(out).toContain('不是可识别的图片格式')
    expect(await tool().extractImages!({ path: 'b.txt' }, ctx())).toBeNull()
  })

  it('超 8MB → 明确拒绝（dataUrl 绝不撑爆上下文）', async () => {
    const p = join(dir, 'big.png')
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(9 * 1024 * 1024, 0)])
    writeFileSync(p, big)
    const out = await tool().run({ path: 'big.png' }, ctx())
    expect(out).toContain('8MB 上限')
    expect(await tool().extractImages!({ path: 'big.png' }, ctx())).toBeNull()
  })

  it('路径不存在 → 载入失败（不抛异常）', async () => {
    const out = await tool().run({ path: 'missing.png' }, ctx())
    expect(out).toContain('图片载入失败')
  })
})

describe('fs_edit 结果 diff 回显体（UI DiffRenderer 数据源）', () => {
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-editdiff-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('替换成功后结果含 @@ hunk（-旧行/+新行/上下文）', async () => {
    const p = join(dir, 'f.ts')
    writeFileSync(p, 'const a = 1;\nconst target = 42;\nconst b = 2;\n', 'utf8')
    const out = await coreTools().fs_edit!.run({ path: 'f.ts', oldText: 'target = 42', newText: 'target = 99' }, { cwd: dir, dataDir: dir, sessionId: 't' } as any)
    expect(out).toContain('已替换 f.ts 中 1 处')
    expect(out).toContain('@@ -2,1 +2,1 @@')
    expect(out).toContain('-target = 42')
    expect(out).toContain('+target = 99')
    expect(out).toContain(' const ') // 同一行前置上下文（needle 起于行中）
    expect(out).toContain(' ;') // 同一行后置上下文
    // 文件确实已改
    expect(readFileSync(p, 'utf8')).toContain('target = 99')
  })
})
