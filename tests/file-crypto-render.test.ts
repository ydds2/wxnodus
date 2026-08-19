// tests/file-crypto-render.test.ts — 2026-08-19「不真实修」：/encrypt 真实加解密 + /render 真实 Markdown
import { describe, expect, it } from 'vitest'
import { encryptBytes, decryptBytes } from '../src/kernel/fileCrypto.js'
import { renderMarkdownText } from '../src/wxnodus-ui/lib/markdown/renderText.js'

describe('fileCrypto（AES-256-GCM + scrypt）', () => {
  it('加密 → 解密真实往返（含中文与二进制）', () => {
    const plain = Buffer.from('机密数据 🔒 secret-123\n第二行', 'utf8')
    const r = encryptBytes(plain, '正确口令')
    expect(r.ok).toBe(true)
    expect(r.data!.subarray(0, 6).toString('ascii')).toBe('WXENC1')
    const back = decryptBytes(r.data!, '正确口令')
    expect(back.ok).toBe(true)
    expect(back.data!.equals(plain)).toBe(true)
  })

  it('错误口令 → 诚实失败（GCM 认证拒绝，不返回垃圾数据）', () => {
    const r = encryptBytes(Buffer.from('x'), '口令A')
    const bad = decryptBytes(r.data!, '口令B')
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('解密失败')
  })

  it('篡改密文 → 诚实失败', () => {
    const r = encryptBytes(Buffer.from('hello world'), 'k')
    const tampered = Buffer.from(r.data!)
    tampered[tampered.length - 1]! ^= 0xff
    expect(decryptBytes(tampered, 'k').ok).toBe(false)
  })

  it('非 WXENC1 输入 → 明确报错', () => {
    expect(decryptBytes(Buffer.from('plain text'), 'k').ok).toBe(false)
  })

  it('同一明文两次加密密文不同（随机盐+IV）', () => {
    const a = encryptBytes(Buffer.from('same'), 'k').data!
    const b = encryptBytes(Buffer.from('same'), 'k').data!
    expect(a.equals(b)).toBe(false)
  })
})

describe('renderMarkdownText（真实解析器渲染）', () => {
  it('标题/列表/代码块/分隔线', () => {
    const out = renderMarkdownText('# 标题\n\n- 甲\n- 乙\n\n---\n\n```js\nconst x = 1\n```')
    expect(out).toEqual(['# 标题', '• 甲', '• 乙', '─'.repeat(24), '```js', 'const x = 1', '```'])
  })

  it('有序列表与引用', () => {
    const out = renderMarkdownText('1. 一\n2. 二\n\n> 引用行')
    expect(out).toEqual(['1. 一', '2. 二', '│ 引用行'])
  })

  it('表格渲染（列对齐）', () => {
    const out = renderMarkdownText('| 名 | 值 |\n|---|---|\n| a | 1 |')
    expect(out[0]).toContain('│ 名')
    expect(out[1]).toContain('┼')
    expect(out[2]).toContain('│ a')
  })

  it('空输入 → 空数组（调用方显示空态）', () => {
    expect(renderMarkdownText('')).toEqual([])
  })
})
