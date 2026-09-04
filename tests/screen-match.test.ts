// tests/screen-match.test.ts — 屏幕模板匹配（2026-09-03 · P1）纯数学契约
// 锁定：jpegSize 头部解析；NCC 命中坐标/满分；阈值过滤；σ≈0（纯色）诚实不命中。
import { describe, it, expect } from 'vitest'
import { jpegSize, pngSize, imageSize, nccMatch, type GrayImage } from '../src/kernel/screenMatch.js'

const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='

/** 最小 PNG 头（签名 + IHDR 长宽——jpegSize/pngSize 解析夹具） */
const pngHeader = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(w, 16)
  buf.writeUInt32BE(h, 20)
  return buf
}

const gray = (w: number, h: number, fill: (x: number, y: number) => number): GrayImage => {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y)
  return { w, h, data }
}

describe('jpegSize/pngSize（图像头部维度解析——解码前事实源）', () => {
  it('解析合法 JPEG 尺寸', () => {
    expect(jpegSize(Buffer.from(TINY_JPEG_B64, 'base64'))).toEqual({ w: 1, h: 1 })
  })
  it('解析 PNG 尺寸（P4 模板双格式）', () => {
    expect(pngSize(pngHeader(160, 90))).toEqual({ w: 160, h: 90 })
    expect(imageSize(pngHeader(160, 90))).toEqual({ w: 160, h: 90 })
  })
  it('非法字节 → null（诚实，不抛）', () => {
    expect(jpegSize(Buffer.from('not-a-jpeg'))).toBeNull()
    expect(pngSize(Buffer.from('not-a-png'))).toBeNull()
    expect(imageSize(Buffer.from('nope'))).toBeNull()
  })
})

describe('nccMatch（归一化互相关）', () => {
  it('模板在帧内 → 精确坐标 + 满分（stride=1）', () => {
    const frame = gray(12, 12, (x, y) => (x >= 4 && x <= 6 && y >= 4 && y <= 6 ? 255 : 0))
    const template = gray(3, 3, () => 255)
    const hit = nccMatch(frame, template, { threshold: 0.99, stride: 1 })
    expect(hit).not.toBeNull()
    expect(hit!.x).toBe(4)
    expect(hit!.y).toBe(4)
    expect(hit!.score).toBeGreaterThan(0.999)
    expect(hit!.frameW).toBe(12)
  })

  it('stride=2 采样同样命中（块在偶数坐标）', () => {
    const frame = gray(12, 12, (x, y) => (x >= 4 && x <= 6 && y >= 4 && y <= 6 ? 255 : 0))
    const hit = nccMatch(frame, gray(3, 3, () => 255), { threshold: 0.9, stride: 2 })
    expect(hit).not.toBeNull()
    expect(hit!.score).toBeGreaterThan(0.999)
  })

  it('帧内无模板 → null（低于阈值诚实不命中）', () => {
    const frame = gray(12, 12, () => 0)
    const hit = nccMatch(frame, gray(3, 3, () => 255), { threshold: 0.8, stride: 1 })
    expect(hit).toBeNull()
  })

  it('纯色模板（σ≈0——NCC 无定义）→ null', () => {
    const frame = gray(12, 12, (x, y) => (x + y) % 7)
    const hit = nccMatch(frame, gray(3, 3, () => 100), { threshold: 0.1, stride: 1 })
    expect(hit).toBeNull()
  })

  it('模板大于帧 → null', () => {
    const hit = nccMatch(gray(2, 2, () => 1), gray(4, 4, () => 1), { stride: 1 })
    expect(hit).toBeNull()
  })
})
