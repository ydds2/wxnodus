import { createWriteStream, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { classifyWindowsResourceName } from '../fs/windowsPathClassifier.js';

export interface SafeTarLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxExpansionRatio: number;
}

export const DEFAULT_SAFE_TAR_LIMITS: SafeTarLimits = {
  maxCompressedBytes: 16 * 1024 * 1024,
  maxEntries: 2_048,
  maxDepth: 16,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxExpansionRatio: 100,
};

interface TarEntry {
  path: string;
  type: 'file' | 'directory';
  body: Buffer;
}

const textField = (header: Buffer, offset: number, length: number): string => {
  const end = header.indexOf(0, offset);
  const sliceEnd = end === -1 || end > offset + length ? offset + length : end;
  return header.subarray(offset, sliceEnd).toString('utf8');
};

const numericField = (header: Buffer, offset: number, length: number): number => {
  const field = header.subarray(offset, offset + length);
  if ((field[0]! & 0x80) !== 0) {
    let value = BigInt(field[0]! & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('tar entry size exceeds safe integer limit');
    return Number(value);
  }
  const raw = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error('tar numeric field is invalid');
  return Number.parseInt(raw, 8);
};

const canonicalArchivePath = (path: string): string => path
  .split('/')
  .map(part => part.replace(/[. ]+$/g, '').toLowerCase())
  .join('/');

const SUPERSCRIPT_DEVICE_NAME = /^(?:com|lpt)[¹²³]$/i;

const assertPortableWindowsResourceName = (path: string): void => {
  const shared = classifyWindowsResourceName(path);
  if (!shared.allowed) throw new Error(shared.reason);
  for (const component of path.split('/')) {
    const basename = (component.replace(/[ .]+$/g, '').split('.', 1)[0] ?? '').replace(/ +$/g, '');
    if (SUPERSCRIPT_DEVICE_NAME.test(basename)) {
      throw new Error(`reserved Windows device name: ${component}`);
    }
  }
};

const safeArchivePath = (input: string, maxDepth: number): string => {
  const normalized = input.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || normalized.startsWith('\\')) {
    throw new Error(`archive path is unsafe: ${JSON.stringify(input)}`);
  }
  if (isAbsolute(normalized) || win32.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`archive path is absolute: ${input}`);
  }
  const parts = normalized.split('/');
  if (parts.length > maxDepth || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`archive path traversal/depth rejected: ${input}`);
  }
  if (parts.some(part => /[. ]$/.test(part) || /[<>:"|?*\u0000-\u001f]/.test(part))) {
    throw new Error(`archive path is not portable to Windows: ${input}`);
  }
  const path = parts.join('/');
  assertPortableWindowsResourceName(path);
  return path;
};

const boundedInflate = async (compressed: Buffer, limits: SafeTarLimits): Promise<Buffer> => {
  if (compressed.byteLength === 0 || compressed.byteLength > limits.maxCompressedBytes) {
    throw new Error(`compressed archive exceeds ${limits.maxCompressedBytes} byte limit`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = Math.min(limits.maxTotalBytes + limits.maxEntries * 512 + 1024, compressed.byteLength * limits.maxExpansionRatio);
  const collector = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > limit) callback(new Error('archive expansion ratio or aggregate byte limit exceeded'));
      else { chunks.push(Buffer.from(chunk)); callback(); }
    },
  });
  await pipeline(Readable.from([compressed]), createGunzip(), collector);
  return Buffer.concat(chunks, total);
};

const parseTar = (tar: Buffer, limits: SafeTarLimits): TarEntry[] => {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let aggregate = 0;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const storedChecksum = numericField(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const computedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== computedChecksum) throw new Error('tar header checksum mismatch');

    const name = textField(header, 0, 100);
    const prefix = textField(header, 345, 155);
    const path = safeArchivePath(prefix ? `${prefix}/${name}` : name, limits.maxDepth);
    const canonical = canonicalArchivePath(path);
    if (seen.has(canonical)) throw new Error(`duplicate archive path: ${path}`);
    seen.add(canonical);
    if (seen.size > limits.maxEntries) throw new Error(`archive entry count exceeds ${limits.maxEntries}`);

    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const size = numericField(header, 124, 12);
    if (size > limits.maxFileBytes) throw new Error(`archive file exceeds ${limits.maxFileBytes} byte limit: ${path}`);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) throw new Error(`truncated tar entry: ${path}`);

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') {
      aggregate += size;
      if (aggregate > limits.maxTotalBytes) throw new Error(`archive aggregate exceeds ${limits.maxTotalBytes} byte limit`);
      entries.push({ path, type: 'file', body: Buffer.from(tar.subarray(bodyStart, bodyEnd)) });
    } else if (typeFlag === '5') {
      if (size !== 0) throw new Error(`directory entry has data: ${path}`);
      entries.push({ path, type: 'directory', body: Buffer.alloc(0) });
    } else if (typeFlag === '1' || typeFlag === '2') {
      throw new Error(`archive link entry rejected: ${path}`);
    } else if (typeFlag === '3' || typeFlag === '4' || typeFlag === '6') {
      throw new Error(`archive device entry rejected: ${path}`);
    } else {
      throw new Error(`unsupported archive entry type ${JSON.stringify(typeFlag)}: ${path}`);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error('archive contains no entries');
  return entries;
};

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export function assertNoReparsePoints(root: string): void {
  const realRoot = resolve(root);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`extracted reparse point rejected: ${target}`);
      if (!inside(realRoot, resolve(target))) throw new Error(`extracted path escaped root: ${target}`);
      if (stat.isDirectory()) walk(target);
      else if (!stat.isFile()) throw new Error(`extracted special file rejected: ${target}`);
    }
  };
  walk(realRoot);
}

export async function extractSafeTarGz(
  compressed: Buffer,
  destination: string,
  limits: SafeTarLimits = DEFAULT_SAFE_TAR_LIMITS,
  requiredFile: string | null = 'SKILL.md',
): Promise<string> {
  const tar = await boundedInflate(compressed, limits);
  const entries = parseTar(tar, limits);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: false });
  try {
    for (const entry of entries.filter(candidate => candidate.type === 'directory')) {
      const target = resolve(destination, ...entry.path.split('/'));
      if (!inside(resolve(destination), target)) throw new Error(`archive path escaped destination: ${entry.path}`);
      mkdirSync(target, { recursive: true });
    }
    for (const entry of entries.filter(candidate => candidate.type === 'file')) {
      const target = resolve(destination, ...entry.path.split('/'));
      if (!inside(resolve(destination), target)) throw new Error(`archive path escaped destination: ${entry.path}`);
      mkdirSync(dirname(target), { recursive: true });
      await pipeline(Readable.from([entry.body]), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    }
    assertNoReparsePoints(destination);
    if (!requiredFile) return destination;
    const matches: string[] = [];
    const findSkill = (dir: string, depth: number): void => {
      if (depth > limits.maxDepth) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const target = join(dir, entry.name);
        if (entry.isDirectory()) findSkill(target, depth + 1);
        else if (entry.isFile() && entry.name === requiredFile) matches.push(dir);
      }
    };
    findSkill(destination, 0);
    if (matches.length !== 1) throw new Error(matches.length === 0 ? `archive contains no ${requiredFile}` : `archive contains multiple ${requiredFile} files`);
    return matches[0]!;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
