// tests/clipboard-image.test.ts — 剪贴板图像捕获（原型 33 附件通道）：PNG IHDR 解析 + 诚实降级面
import { describe, expect, it } from 'vitest'
import { pngDimensions } from '../src/kernel/clipboardImage.js'

/** 构造最小 PNG 头（签名 + IHDR + width/height）——不依赖图像库 */
function pngHead(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf.writeUInt32BE(0x89504e47, 0) // PNG 签名
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8) // IHDR 长度
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('PNG IHDR 尺寸解析（零依赖）', () => {
  it('1920×1080 截图头解析', () => {
    expect(pngDimensions(pngHead(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('非 PNG / 截断头 → null（诚实不猜）', () => {
    expect(pngDimensions(Buffer.from('GIF89a........', 'ascii'))).toBeNull()
    expect(pngDimensions(Buffer.alloc(10))).toBeNull()
  })
})
