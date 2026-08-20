// src/application/release/zipArchive.ts — 自研最小 ZIP 写入/读回（零第三方依赖，§10-4 完整集成）：
// 写入：确定性（UTF-8 文件名 + deflateRaw + 固定 DOS 时间戳 1980-01-01 + 条目按路径排序）
// 读回：中央目录解析 + inflateRaw；路径护栏（拒绝绝对路径/.. 穿越）；损坏 → ZIP_CORRUPT
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export interface ZipEntryInput { path: string; content: Buffer }

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
// 确定性打包：固定 DOS 时间 1980-01-01 00:00:00（避免每次构建产出漂移）
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;

const isSafeZipPath = (path: string) =>
  path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) &&
  !path.split('/').includes('..');

export function buildZip(entries: ZipEntryInput[]): Buffer {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of sorted) {
    if (!isSafeZipPath(entry.path)) {
      throw new Error(`ZIP_PATH_UNSAFE: ${entry.path}`);
    }
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = deflateRawSync(entry.content);
    const checksum = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // flags: UTF-8 names
    local.writeUInt16LE(8, 8);         // method: deflate
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);        // extra length
    chunks.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CENTRAL, 0);
    header.writeUInt16LE(20, 4);       // version made by
    header.writeUInt16LE(20, 6);       // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(FIXED_DOS_TIME, 12);
    header.writeUInt16LE(FIXED_DOS_DATE, 14);
    header.writeUInt32LE(checksum >>> 0, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);       // external attrs
    header.writeUInt32LE(0, 38);       // external attrs high
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, eocd]);
}

export function readZip(buffer: Buffer): OperationResult<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  try {
    const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocdOffset < 0) return corrupted('ZIP_CORRUPT');
    const count = buffer.readUInt16LE(eocdOffset + 10);
    let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
    for (let index = 0; index < count; index += 1) {
      if (buffer.readUInt32LE(centralOffset) !== SIG_CENTRAL) return corrupted('ZIP_CORRUPT');
      const nameLength = buffer.readUInt16LE(centralOffset + 28);
      const extraLength = buffer.readUInt16LE(centralOffset + 30);
      const commentLength = buffer.readUInt16LE(centralOffset + 32);
      const localOffset = buffer.readUInt32LE(centralOffset + 42);
      const name = buffer.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLength);
      centralOffset += 46 + nameLength + extraLength + commentLength;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const method = buffer.readUInt16LE(localOffset + 8);
      const compressedSize = buffer.readUInt32LE(localOffset + 18);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    }
  } catch {
    return corrupted('ZIP_CORRUPT');
  }
  return { ok: true, value: entries };
}

const corrupted = (code: string): OperationResult<never> => ({ ok: false, error: configError(code, 'zip.corrupt') });

/** 包指纹（sha256 over 原始 zip 字节）——安装器 manifest 绑定 */
export const zipSha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
