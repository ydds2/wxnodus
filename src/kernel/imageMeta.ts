// src/kernel/imageMeta.ts — 图片元数据（零依赖：魔数检测 + 头解析宽高 + 视觉 token 估算）
// 用途：image.attach / clipboard.paste 返回 UI 元数据（宽高/估算 token），并验证文件确为图片

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif';

// 魔数检测：PNG/JPEG/WebP/GIF，非图片返回 null
export function detectImageType(buf: Buffer): ImageKind | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a') return 'gif';
  return null;
}

// 头部解析宽高（不解码全图）：
//  PNG  : IHDR 在偏移 16（签名8 + 长度4 + "IHDR"4），宽/高各 4 字节大端
//  JPEG : 扫描 SOF0-3/SOF5-7/SOF9-11/SOF13-15 标记（FF Cx），高/宽各 2 字节大端
//  GIF  : 逻辑屏幕宽/高小端（偏移 6/8）
//  WebP : VP8 帧 ｜ VP8L 无损 ｜ VP8X 扩展（24 位小端画布）
export function readImageDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    const kind = detectImageType(buf);
    if (!kind) return null;
    if (kind === 'png') {
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
        if (marker === 0xda) break; // SOS：数据开始
        const len = buf.readUInt16BE(i + 2);
        const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
        if (isSof && i + 9 < buf.length) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (kind === 'gif') {
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // webp
    if (buf.toString('latin1', 12, 16) === 'VP8X' && buf.length >= 30) {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (buf.toString('latin1', 12, 16) === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (buf.toString('latin1', 12, 16) === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  } catch { return null; }
}

// 视觉 token 估算（OpenAI vision 惯例：~750 像素/token，与 glm-4v 同量级）
export function estimateVisionTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.max(1, Math.ceil((width * height) / 750));
}
