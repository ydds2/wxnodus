// tests/kernel-imageMeta.test.ts — P3 图片元数据：魔数检测/头解析宽高/token 估算（零依赖）
import { describe, it, expect } from 'vitest';
import { detectImageType, readImageDimensions, estimateVisionTokens } from '../src/kernel/imageMeta.js';

// 合成最小 PNG（签名 + IHDR：宽 0x100=256 高 0x80=128）
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR 长度
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// 合成最小 JPEG（SOI + SOF0：高 480 宽 640）
function makeJpeg(width: number, height: number): Buffer {
  const buf = Buffer.alloc(19);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; // SOI
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4); // 段长
  buf[6] = 8; // 精度
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

describe('detectImageType 魔数检测', () => {
  it('识别四种受支持格式', () => {
    expect(detectImageType(makePng(1, 1))).toBe('png');
    expect(detectImageType(makeJpeg(1, 1))).toBe('jpeg');
    const gif = Buffer.from('GIF89a' + '\x00'.repeat(10), 'latin1');
    expect(detectImageType(gif)).toBe('gif');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8 '), Buffer.alloc(12)]);
    expect(detectImageType(webp)).toBe('webp');
  });
  it('非图片/过短返回 null', () => {
    expect(detectImageType(Buffer.alloc(4))).toBeNull();
    expect(detectImageType(Buffer.from('hello world text file', 'utf8'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('readImageDimensions 头解析', () => {
  it('PNG 宽高（大端 IHDR）', () => {
    expect(readImageDimensions(makePng(256, 128))).toEqual({ width: 256, height: 128 });
    expect(readImageDimensions(makePng(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });
  it('JPEG SOF0 宽高', () => {
    expect(readImageDimensions(makeJpeg(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it('GIF 宽高（小端）', () => {
    const gif = Buffer.alloc(12);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(readImageDimensions(gif)).toEqual({ width: 320, height: 240 });
  });
  it('截断/非法缓冲返回 null（不抛）', () => {
    expect(readImageDimensions(Buffer.alloc(2))).toBeNull();
    expect(readImageDimensions(makePng(1, 1).subarray(0, 12))).toBeNull();
    expect(readImageDimensions(Buffer.from('GIF89a', 'latin1'))).toBeNull();
  });
});

describe('estimateVisionTokens', () => {
  it('按 ~750 像素/token 估算并向上取整', () => {
    expect(estimateVisionTokens(750, 1)).toBe(1);
    expect(estimateVisionTokens(1920, 1080)).toBe(Math.ceil((1920 * 1080) / 750));
    expect(estimateVisionTokens(1, 1)).toBe(1);
  });
  it('非法输入返回 0', () => {
    expect(estimateVisionTokens(0, 0)).toBe(0);
    expect(estimateVisionTokens(Number.NaN, 10)).toBe(0);
    expect(estimateVisionTokens(-5, 10)).toBe(0);
  });
});
