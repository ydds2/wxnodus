// src/infrastructure/quality/fileEvidenceStore.ts — 不可变 evidence 存储：输入校验 → 临时目录 → readback → 原子 rename → 只读
// W3-01 扩展：appendClosed/appendBundle/verifyIntegrity(runId) 的 run bundle 布局（manifest + records + attachments），
// 与 W1-09 的 per-record 布局/WeakSet 收据信任模型并存——receipt 只能由本 store 实例签发（owns），不引入 trusted 字段。
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeepReadonly, EvidenceAttachment, EvidenceAttachmentRef, EvidenceRecord, EvidenceRef, VerifiedEvidenceReceipt } from '../../domain/quality/evidence.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); }
  return value as DeepReadonly<T>;
}
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const SHA256 = /^[a-f0-9]{64}$/;
function snapshotEvidenceRef(value: unknown): Readonly<EvidenceRef> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    structuredClone(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some(key => typeof key !== 'string' || (key !== 'id' && key !== 'sha256'))) return null;
    const id = descriptors.id, sha256 = descriptors.sha256;
    if (!id || !sha256 || !('value' in id) || !('value' in sha256) || !id.enumerable || !sha256.enumerable ||
        !safeId(id.value) || typeof sha256.value !== 'string' || !SHA256.test(sha256.value)) return null;
    return Object.freeze({ id: id.value, sha256: sha256.value });
  } catch {
    return null;
  }
}
const VERIFICATION_STATUSES = new Set(['passed', 'failed', 'inconclusive', 'cancelled']);
function hasDenseValidCriteria(record: unknown): record is EvidenceRecord {
  if (typeof record !== 'object' || record === null) return false;
  const criteria = (record as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria) || Object.getPrototypeOf(criteria) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(criteria);
  const length = criteria.length;
  if (!Number.isSafeInteger(length) || length < 1) return false;
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(criteria).some(key => typeof key !== 'string' || !expectedKeys.has(key))) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
    const criterion = descriptor.value;
    if (typeof criterion !== 'object' || criterion === null || Array.isArray(criterion) || Object.getPrototypeOf(criterion) !== Object.prototype) return false;
    const item = criterion as Record<string, unknown>;
    if (!safeId(item.id) || typeof item.description !== 'string' || item.description.trim().length === 0 ||
        typeof item.required !== 'boolean' || typeof item.status !== 'string' || !VERIFICATION_STATUSES.has(item.status)) return false;
  }
  return true;
}
const fail = <T = never>(code: string): OperationResult<T> => err(gatewayError(code, code, `evidence.${code.toLowerCase()}`));
// 函数声明形式：TS 对显式 never 返回的函数声明做 CFA 收窄（guard 后 target 直接可用）
function raise(code: string): never { throw Object.assign(new Error(code), { code }); }
// W3-01：run bundle 布局的 manifest 契约（与 per-record 布局并存）
export interface ManifestEntry { path: string; attachmentId?: string; bytes: number; sha256: string }
export interface ArtifactManifest { algorithm: 'sha256'; rootDigest: string; entries: ManifestEntry[] }
interface EvidenceBundle { runId: string; records: EvidenceRecord[]; attachments: Record<string, Buffer> }
interface PreparedEvidenceRecord { record: EvidenceRecord; bytes: Buffer; ref: EvidenceRef }
interface PreparedEvidenceBundle { runId: string; records: PreparedEvidenceRecord[]; attachments: Record<string, Buffer> }
interface VerifiedBundleRecord { entry: ManifestEntry; bytes: Buffer; record: EvidenceRecord }
interface VerifiedEvidenceBundle {
  manifest: ArtifactManifest;
  records: Map<string, VerifiedBundleRecord>;
  attachments: Record<string, Buffer>;
}
interface TrustedRoot { lexical: string; real: string; dev: number; ino: number }

function snapshotPlainValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) raise('EVIDENCE_WRITE_FAILED');
    return value;
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== 'object' || ancestors.has(value)) raise('EVIDENCE_WRITE_FAILED');
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) raise('EVIDENCE_WRITE_FAILED');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== Array.prototype) raise('EVIDENCE_WRITE_FAILED');
  let current: object | null = value;
  while (current !== null) {
    if (Object.prototype.hasOwnProperty.call(current, 'toJSON')) raise('EVIDENCE_WRITE_FAILED');
    current = Object.getPrototypeOf(current) as object | null;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = value.length;
      const keys = Reflect.ownKeys(value);
      const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
      if (!Number.isSafeInteger(length) || keys.some(key => typeof key !== 'string' || !expected.has(key))) raise('EVIDENCE_WRITE_FAILED');
      return Array.from({ length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) raise('EVIDENCE_WRITE_FAILED');
        return snapshotPlainValue(descriptor.value, ancestors);
      });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) raise('EVIDENCE_WRITE_FAILED');
    return Object.fromEntries(keys.map(key => {
      const stringKey = key as string;
      const descriptor = descriptors[stringKey];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) raise('EVIDENCE_WRITE_FAILED');
      return [stringKey, snapshotPlainValue(descriptor.value, ancestors)];
    }));
  } finally {
    ancestors.delete(value);
  }
}

function snapshotRecord(record: EvidenceRecord): EvidenceRecord {
  return snapshotPlainValue(record) as EvidenceRecord;
}

function snapshotPending(pending: readonly { attachmentId: string; bytes: Buffer }[]): Array<{ attachmentId: string; bytes: Buffer }> {
  if (!Array.isArray(pending) || Object.getPrototypeOf(pending) !== Array.prototype) raise('EVIDENCE_WRITE_FAILED');
  const descriptors = Object.getOwnPropertyDescriptors(pending);
  const expected = new Set(['length', ...Array.from({ length: pending.length }, (_, index) => String(index))]);
  if (!Number.isSafeInteger(pending.length) || Reflect.ownKeys(pending).some(key => typeof key !== 'string' || !expected.has(key))) raise('EVIDENCE_WRITE_FAILED');
  return Array.from({ length: pending.length }, (_, index) => {
    const itemDescriptor = descriptors[String(index)];
    if (!itemDescriptor || !('value' in itemDescriptor) || !itemDescriptor.enumerable) raise('EVIDENCE_WRITE_FAILED');
    const item = itemDescriptor.value;
    if (typeof item !== 'object' || item === null || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) raise('EVIDENCE_WRITE_FAILED');
    const itemDescriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(item);
    if (keys.length !== 2 || keys.some(key => typeof key !== 'string' || (key !== 'attachmentId' && key !== 'bytes'))) raise('EVIDENCE_WRITE_FAILED');
    const attachmentId = itemDescriptors.attachmentId, bytes = itemDescriptors.bytes;
    if (!attachmentId || !bytes || !('value' in attachmentId) || !('value' in bytes) || !attachmentId.enumerable || !bytes.enumerable ||
        !safeId(attachmentId.value) || !Buffer.isBuffer(bytes.value)) raise('EVIDENCE_WRITE_FAILED');
    return { attachmentId: attachmentId.value, bytes: Buffer.from(bytes.value) };
  });
}

function prepareRecord(record: EvidenceRecord): PreparedEvidenceRecord {
  const frozen = snapshotRecord(record);
  if (!safeId(frozen.id) || !safeId(frozen.runId) || !hasDenseValidCriteria(frozen)) raise('EVIDENCE_WRITE_FAILED');
  const bytes = Buffer.from(JSON.stringify(frozen, null, 2), 'utf8');
  return { record: frozen, bytes, ref: Object.freeze({ id: frozen.id, sha256: digest(bytes) }) };
}

function prepareBundle(bundle: EvidenceBundle): PreparedEvidenceBundle {
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle) || Object.getPrototypeOf(bundle) !== Object.prototype) {
    raise('EVIDENCE_WRITE_FAILED');
  }
  const descriptors = Object.getOwnPropertyDescriptors(bundle);
  const keys = Reflect.ownKeys(bundle);
  if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !['runId', 'records', 'attachments'].includes(key))) {
    raise('EVIDENCE_WRITE_FAILED');
  }
  const runId = descriptors.runId, records = descriptors.records, attachments = descriptors.attachments;
  if (!runId || !records || !attachments || !('value' in runId) || !('value' in records) || !('value' in attachments) ||
      !runId.enumerable || !records.enumerable || !attachments.enumerable || !safeId(runId.value)) raise('EVIDENCE_WRITE_FAILED');
  const frozenRecords = snapshotPlainValue(records.value) as EvidenceRecord[];
  if (!Array.isArray(frozenRecords) || frozenRecords.some(record => record.runId !== runId.value)) raise('EVIDENCE_WRITE_FAILED');
  const preparedRecords = frozenRecords.map(prepareRecord);
  if (new Set(preparedRecords.map(item => item.record.id)).size !== preparedRecords.length) raise('EVIDENCE_DUPLICATE_ID');
  const frozenAttachments = snapshotPlainValue(attachments.value);
  if (typeof frozenAttachments !== 'object' || frozenAttachments === null || Array.isArray(frozenAttachments)) raise('EVIDENCE_WRITE_FAILED');
  const copiedAttachments: Record<string, Buffer> = {};
  for (const [name, bytes] of Object.entries(frozenAttachments)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !Buffer.isBuffer(bytes)) raise('EVIDENCE_WRITE_FAILED');
    copiedAttachments[name] = Buffer.from(bytes);
  }
  return { runId: runId.value, records: preparedRecords, attachments: copiedAttachments };
}

async function ensureTrustedRoot(path: string): Promise<TrustedRoot | null> {
  const lexical = resolve(path);
  const missing: string[] = [];
  let current = lexical;
  while (true) {
    const stat = await lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (stat) break;
    const parent = dirname(current);
    if (parent === current) return null;
    missing.push(current);
    current = parent;
  }
  const existing = await trustedRoot(current);
  if (!existing) return null;
  for (const component of [...missing].reverse()) {
    if (!isContained(existing.lexical, component, false) && component !== existing.lexical) return null;
    try { await mkdir(component); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    const created = await trustedRoot(component);
    if (!created || created.real !== component) return null;
  }
  return await trustedRoot(lexical);
}

async function durableWrite(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

interface WriteLock { path: string; handle: FileHandle }
const WRITE_LOCK_RETRIES = 80;
const WRITE_LOCK_DELAY_MS = 25;
async function acquireWriteLock(root: TrustedRoot): Promise<WriteLock | null> {
  const path = join(root.lexical, '.evidence-write.lock');
  for (let attempt = 0; attempt < WRITE_LOCK_RETRIES; attempt += 1) {
    if (!await validateTrustedRoot(root)) return null;
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
        await handle.sync();
        return { path, handle };
      } catch {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      await sleep(WRITE_LOCK_DELAY_MS);
    }
  }
  return null;
}
async function releaseWriteLock(lock: WriteLock): Promise<boolean> {
  try {
    await lock.handle.close();
    const stat = await lstat(lock.path).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return false;
    await unlink(lock.path);
    return true;
  } catch {
    return false;
  }
}
const refsOf = (record: EvidenceRecord): EvidenceAttachmentRef[] => [record.stdout, record.stderr, ...(record.attachments ?? [])];
function hasExactClosure(record: EvidenceRecord, refs: readonly EvidenceAttachmentRef[]): boolean {
  if (record.attachments === undefined && record.closure === undefined) return true;
  if (record.closure?.status !== 'closed') return false;
  const refIds = refs.map(ref => ref.attachmentId), closureIds = record.closure.attachmentIds;
  return closureIds.length === refIds.length && new Set(closureIds).size === closureIds.length && closureIds.every(id => refIds.includes(id));
}
function containedPath(base: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const target = resolve(base, ...relativePath.split('/')), rel = relative(base, target);
  return !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : target;
}
function isContained(base: string, target: string, allowBase = false): boolean {
  const rel = relative(base, target);
  return (allowBase && rel === '') || (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
async function trustedRoot(path: string): Promise<TrustedRoot | null> {
  const lexical = resolve(path);
  const stat = await lstat(lexical).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  const real = await realpath(lexical).catch(() => null);
  if (!real || resolve(real) !== lexical) return null;
  return { lexical, real: resolve(real), dev: stat.dev, ino: stat.ino };
}
async function validateTrustedRoot(root: TrustedRoot): Promise<boolean> {
  const stat = await lstat(root.lexical).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== root.dev || stat.ino !== root.ino) return false;
  const real = await realpath(root.lexical).catch(() => null);
  return !!real && resolve(real) === root.real;
}
async function validatePathComponents(root: TrustedRoot, target: string, expectDirectory: boolean): Promise<boolean> {
  const absolute = resolve(target);
  if (!isContained(root.lexical, absolute, true) || !await validateTrustedRoot(root)) return false;
  const rel = relative(root.lexical, absolute);
  if (rel === '') return expectDirectory;
  let current = root.lexical;
  const parts = rel.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const stat = await lstat(current).catch(() => null);
    const isFinal = index === parts.length - 1;
    if (!stat || stat.isSymbolicLink()) return false;
    if (isFinal ? (expectDirectory ? !stat.isDirectory() : !stat.isFile()) : !stat.isDirectory()) return false;
    const real = await realpath(current).catch(() => null);
    if (!real || !isContained(root.real, resolve(real), false)) return false;
  }
  return true;
}
async function readTrustedFile(root: TrustedRoot, target: string): Promise<Buffer | null> {
  if (!await validatePathComponents(root, target, false)) return null;
  const handle = await open(target, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return null;
    const bytes = await handle.readFile();
    if (!await validateTrustedRoot(root)) return null;
    const current = await lstat(target).catch(() => null);
    if (!current || !current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) return null;
    const real = await realpath(target).catch(() => null);
    return real && isContained(root.real, resolve(real), false) ? bytes : null;
  } finally {
    await handle.close();
  }
}
async function listRegularFiles(root: string, prefix = ''): Promise<string[]> {
  const dir = prefix ? join(root, ...prefix.split('/')) : root, output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) raise('EVIDENCE_ATTACHMENT_PATH_INVALID');
    if (entry.isDirectory()) output.push(...await listRegularFiles(root, path));
    else if (entry.isFile()) output.push(path);
    else raise('EVIDENCE_ATTACHMENT_PATH_INVALID');
  }
  return output.sort();
}
export class FileEvidenceStore {
  readonly #receipts = new WeakSet<object>();
  readonly #brand = true;
  readonly #runQueues = new Map<string, Promise<void>>();
  readonly #root: string;
  constructor(root: string, private readonly clock: () => string = () => new Date().toISOString()) {
    this.#root = resolve(root);
  }
  static isGenuine(value: unknown): value is FileEvidenceStore {
    return typeof value === 'object' && value !== null && #brand in value;
  }
  owns(receipt: unknown): receipt is VerifiedEvidenceReceipt { return typeof receipt === 'object' && receipt !== null && this.#receipts.has(receipt); }
  async append(record: EvidenceRecord, attachments: readonly EvidenceAttachment[]): Promise<OperationResult<EvidenceRef>> {
    let frozenRecord: EvidenceRecord;
    let frozenAttachments: EvidenceAttachment[];
    try {
      frozenRecord = snapshotRecord(record);
      frozenAttachments = snapshotPlainValue(attachments) as EvidenceAttachment[];
      frozenAttachments = frozenAttachments.map(item => ({
        ...item,
        content: Buffer.from(item.content),
      }));
    } catch {
      return fail('EVIDENCE_WRITE_FAILED');
    }
    record = frozenRecord;
    attachments = frozenAttachments;
    if (!safeId(record.id) || !safeId(record.runId) || !hasDenseValidCriteria(record)) return fail('EVIDENCE_WRITE_FAILED');
    const refs = refsOf(record), refIds = refs.map(x => x.attachmentId), refPaths = refs.map(x => x.relativePath), inputIds = attachments.map(x => x.attachmentId);
    if (!hasExactClosure(record, refs)) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
    if (new Set(refIds).size !== refs.length || new Set(inputIds).size !== attachments.length) return fail('EVIDENCE_ATTACHMENT_ID_DUPLICATE');
    if (new Set(refPaths).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
    const byId = new Map(attachments.map(item => [item.attachmentId, item]));
    if (byId.size !== refs.length || refs.some(ref => !byId.has(ref.attachmentId)) || attachments.some(item => !refIds.includes(item.attachmentId))) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
    for (const ref of refs) {
      const input = byId.get(ref.attachmentId)!;
      if (!safeId(ref.attachmentId)) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      if (!containedPath('/', ref.relativePath)) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
      if (input.relativePath !== ref.relativePath) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      if (input.content.byteLength !== ref.bytes) return fail('EVIDENCE_ATTACHMENT_LENGTH_MISMATCH');
      if (!/^[a-f0-9]{64}$/.test(ref.sha256) || digest(input.content) !== ref.sha256) return fail('EVIDENCE_ATTACHMENT_HASH_MISMATCH');
    }
    const recordsRoot = join(this.#root, 'records'), finalDir = join(recordsRoot, record.id);
    const tempDir = join(recordsRoot, `.tmp-${record.id}-${randomUUID()}`), attachmentRoot = join(tempDir, 'attachments');
    try {
      const root = await ensureTrustedRoot(this.#root);
      if (!root) return fail('EVIDENCE_INTEGRITY_FAILED');
      const recordsStat = await lstat(recordsRoot).catch(() => null);
      if (recordsStat?.isSymbolicLink() || (recordsStat && !recordsStat.isDirectory())) return fail('EVIDENCE_INTEGRITY_FAILED');
      await mkdir(recordsRoot, { recursive: true });
      if (!await validatePathComponents(root, recordsRoot, true)) return fail('EVIDENCE_INTEGRITY_FAILED');
      for (const ref of refs) {
        const input = byId.get(ref.attachmentId)!;
        const target = containedPath(attachmentRoot, ref.relativePath);
        if (!target) raise('EVIDENCE_ATTACHMENT_PATH_INVALID');
        await mkdir(dirname(target), { recursive: true }); const handle = await open(target, 'wx');
        try { await handle.writeFile(input.content); await handle.sync(); } finally { await handle.close(); }
        const readback = await open(target, 'r');
        try { const stat = await readback.stat(), bytes = await readback.readFile(); if (!stat.isFile() || stat.size !== ref.bytes || bytes.byteLength !== ref.bytes) raise('EVIDENCE_ATTACHMENT_LENGTH_MISMATCH'); if (digest(bytes) !== ref.sha256) raise('EVIDENCE_ATTACHMENT_HASH_MISMATCH'); }
        finally { await readback.close(); }
      }
      const recordBytes = Buffer.from(JSON.stringify(record), 'utf8'), recordHandle = await open(join(tempDir, 'record.json'), 'wx');
      try { await recordHandle.writeFile(recordBytes); await recordHandle.sync(); } finally { await recordHandle.close(); }
      await rename(tempDir, finalDir);
      for (const ref of refs) await chmod(join(finalDir, 'attachments', ...ref.relativePath.split('/')), 0o444); await chmod(join(finalDir, 'record.json'), 0o444);
      const ref = { id: record.id, sha256: digest(recordBytes) }, verified = await this.verifyStored(ref); if (!verified.ok) return verified;
      return ok(ref);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === 'string' && code.startsWith('EVIDENCE_')) return fail(code);
      return code === 'EEXIST' || code === 'ENOTEMPTY' ? fail('EVIDENCE_IMMUTABLE_VIOLATION') : fail('EVIDENCE_WRITE_FAILED');
    }
  }
  verifyIntegrity(ref: EvidenceRef): Promise<OperationResult<EvidenceRef>>;
  /** W3-01：run bundle 级完整性——重读实际 bytes（不信任落盘 hash），闭包/篡改 fail closed */
  verifyIntegrity(runId: string): Promise<OperationResult<ArtifactManifest>>;
  verifyIntegrity(target: EvidenceRef | string): Promise<OperationResult<EvidenceRef | ArtifactManifest>> {
    if (typeof target === 'string') {
      return this.verifyRunBundle(target).then(result => result.ok ? ok(result.value.manifest) : result);
    }
    const ref = snapshotEvidenceRef(target);
    if (!ref) return Promise.resolve(fail('EVIDENCE_INTEGRITY_FAILED'));
    return this.verifyStored(ref).then(result => result.ok ? ok(ref) : result);
  }
  /** W3-01：EvidenceService 闭合通道——closure 校验 + 全量附件 hash/length/path 核对后原子换入 run bundle */
  async appendClosed(record: EvidenceRecord, pending: readonly { attachmentId: string; bytes: Buffer }[]): Promise<OperationResult<{ evidenceId: string; ref: EvidenceRef }>> {
    let prepared: PreparedEvidenceRecord;
    let frozenPending: Array<{ attachmentId: string; bytes: Buffer }>;
    try {
      prepared = prepareRecord(record);
      frozenPending = snapshotPending(pending);
    } catch {
      return fail('EVIDENCE_WRITE_FAILED');
    }
    record = prepared.record;
    pending = frozenPending;
    if (!safeId(record.id) || !safeId(record.runId) || !hasDenseValidCriteria(record)) return fail('EVIDENCE_WRITE_FAILED');
    if (record.closure?.status !== 'closed') return fail('EVIDENCE_RECORD_NOT_CLOSED');
    if (new Set(pending.map(item => item.attachmentId)).size !== pending.length) return fail('EVIDENCE_DUPLICATE_ID');
    if (pending.some(item => !/^[A-Za-z0-9._-]+$/.test(item.attachmentId))) return fail('EVIDENCE_PATH_OUTSIDE_RUN');
    const refs = [record.stdout, record.stderr, ...(record.attachments ?? [])];
    const refIds = refs.map(ref => ref.attachmentId);
    if (new Set(refIds).size !== refs.length) return fail('EVIDENCE_DUPLICATE_ID');
    const closureIds = record.closure.attachmentIds;
    if (closureIds.length !== refIds.length || new Set(closureIds).size !== closureIds.length || closureIds.some(id => !refIds.includes(id))) {
      return fail('EVIDENCE_RECORD_NOT_CLOSED');
    }
    const pendingIds = pending.map(item => item.attachmentId);
    if (pendingIds.length !== refIds.length || pendingIds.some(id => !refIds.includes(id))) {
      return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
    }
    const byId = new Map(pending.map(item => [item.attachmentId, item]));
    for (const ref of refs) {
      const input = byId.get(ref.attachmentId);
      if (!input) return fail('EVIDENCE_ATTACHMENT_MISSING');
      if ((ref.path ?? ref.relativePath) !== `attachments/${ref.attachmentId}`) return fail('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
      if (!/^[a-f0-9]{64}$/.test(ref.sha256) || digest(input.bytes) !== ref.sha256) return fail('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
      if (input.bytes.byteLength !== ref.bytes) return fail('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
    }
    return this.withWriteLock(record.runId, async root => {
      const runPath = join(root.lexical, record.runId);
      const existing = await lstat(runPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) return fail('EVIDENCE_INTEGRITY_FAILED');
      if (existing) {
        const integrity = await this.verifyRunBundle(record.runId);
        if (!integrity.ok) return integrity;
        const current = this.bundleFromVerified(record.runId, integrity.value);
        if (current.records.some(item => item.record.id === record.id) ||
            pending.some(item => Object.hasOwn(current.attachments, item.attachmentId))) return fail('EVIDENCE_DUPLICATE_ID');
        const attachments = { ...current.attachments };
        for (const item of pending) attachments[item.attachmentId] = Buffer.from(item.bytes);
        const written = await this.appendBundleUnlocked({ runId: record.runId, records: [...current.records, prepared], attachments }, root);
        if (!written.ok) return written;
      } else {
        const attachments = Object.fromEntries(pending.map(item => [item.attachmentId, Buffer.from(item.bytes)]));
        const written = await this.appendBundleUnlocked({ runId: record.runId, records: [prepared], attachments }, root);
        if (!written.ok) return written;
      }
      return ok({ evidenceId: record.id, ref: prepared.ref });
    });
  }
  /** W3-01：整捆原子写入（manifest 根摘要 + 排序条目），目录换入 rollback-safe，每个文件 sync 后 rename */
  async appendBundle(bundle: EvidenceBundle): Promise<OperationResult<{ evidenceId: string }>> {
    let prepared: PreparedEvidenceBundle;
    try {
      prepared = prepareBundle(bundle);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_WRITE_FAILED');
    }
    return this.withWriteLock(prepared.runId, root => this.appendBundleUnlocked(prepared, root));
  }
  private async appendBundleUnlocked(bundle: PreparedEvidenceBundle, root: TrustedRoot): Promise<OperationResult<{ evidenceId: string }>> {
    const finalDir = join(root.lexical, bundle.runId);
    const tempDir = join(root.lexical, `.${bundle.runId}.${randomUUID()}.tmp`);
    const backupDir = join(root.lexical, `.${bundle.runId}.${randomUUID()}.bak`);
    let movedOld = false;
    let published = false;
    try {
      if (!await validateTrustedRoot(root)) return fail('EVIDENCE_INTEGRITY_FAILED');
      await mkdir(tempDir);
      if (!await validatePathComponents(root, tempDir, true)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const entries: ManifestEntry[] = [];
      for (const item of bundle.records) {
        const path = `records/${item.record.id}.json`;
        await durableWrite(join(tempDir, ...path.split('/')), item.bytes);
        entries.push({ path, bytes: item.bytes.byteLength, sha256: item.ref.sha256 });
      }
      for (const [name, bytes] of Object.entries(bundle.attachments)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name) || !Buffer.isBuffer(bytes)) raise('EVIDENCE_WRITE_FAILED');
        const path = `attachments/${name}`;
        await durableWrite(join(tempDir, ...path.split('/')), bytes);
        entries.push({ path, attachmentId: name, bytes: bytes.byteLength, sha256: digest(bytes) });
      }
      entries.sort((left, right) => left.path.localeCompare(right.path));
      const rootDigest = digest(entries.map(entry => `${entry.path}\0${entry.attachmentId ?? ''}\0${entry.bytes}\0${entry.sha256}`).join('\n'));
      const manifest: ArtifactManifest = { algorithm: 'sha256', rootDigest, entries };
      await durableWrite(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      if (!await validateTrustedRoot(root) || !await validatePathComponents(root, tempDir, true)) raise('EVIDENCE_INTEGRITY_FAILED');
      const finalStat = await lstat(finalDir).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (finalStat && (!finalStat.isDirectory() || finalStat.isSymbolicLink())) raise('EVIDENCE_INTEGRITY_FAILED');
      if (finalStat) {
        await rename(finalDir, backupDir);
        movedOld = true;
      }
      if (!await validateTrustedRoot(root) || !await validatePathComponents(root, tempDir, true)) raise('EVIDENCE_INTEGRITY_FAILED');
      await rename(tempDir, finalDir);
      published = true;
      const verified = await this.verifyRunBundle(bundle.runId);
      if (!verified.ok || verified.value.manifest.rootDigest !== rootDigest ||
          verified.value.records.size !== bundle.records.length ||
          verified.value.manifest.entries.length !== entries.length) raise('EVIDENCE_INTEGRITY_FAILED');
      for (const item of bundle.records) {
        const actual = verified.value.records.get(item.record.id);
        if (!actual || actual.entry.sha256 !== item.ref.sha256 || !actual.bytes.equals(item.bytes)) raise('EVIDENCE_INTEGRITY_FAILED');
      }
      for (const [id, bytes] of Object.entries(bundle.attachments)) {
        if (!verified.value.attachments[id]?.equals(bytes)) raise('EVIDENCE_INTEGRITY_FAILED');
      }
      if (movedOld) await rm(backupDir, { recursive: true, force: true });
      return ok({ evidenceId: bundle.records.at(-1)?.record.id ?? `bundle-${bundle.runId}` });
    } catch (error) {
      let restored = true;
      if (published) await rm(finalDir, { recursive: true, force: true }).catch(() => { restored = false; });
      await rm(tempDir, { recursive: true, force: true }).catch(() => { restored = false; });
      if (movedOld) {
        try {
          if (!await validateTrustedRoot(root)) restored = false;
          else await rename(backupDir, finalDir);
        } catch {
          restored = false;
        }
      }
      if (!restored) return fail('EVIDENCE_WRITE_FAILED');
      const code = (error as NodeJS.ErrnoException).code;
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_WRITE_FAILED');
    }
  }
  private bundleFromVerified(runId: string, verified: VerifiedEvidenceBundle): PreparedEvidenceBundle {
    return {
      runId,
      records: [...verified.records.values()].map(item => ({
        record: item.record,
        bytes: Buffer.from(item.bytes),
        ref: Object.freeze({ id: item.record.id, sha256: item.entry.sha256 }),
      })),
      attachments: Object.fromEntries(Object.entries(verified.attachments).map(([id, bytes]) => [id, Buffer.from(bytes)])),
    };
  }
  private async withWriteLock<T>(runId: string, action: (root: TrustedRoot) => Promise<OperationResult<T>>): Promise<OperationResult<T>> {
    return this.withRunQueue(runId, async () => {
      const root = await ensureTrustedRoot(this.#root);
      if (!root || !await validateTrustedRoot(root)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const lock = await acquireWriteLock(root);
      if (!lock) return fail('EVIDENCE_WRITE_LOCKED');
      let result: OperationResult<T>;
      try {
        result = !await validateTrustedRoot(root) ? fail('EVIDENCE_INTEGRITY_FAILED') : await action(root);
      } catch {
        result = fail('EVIDENCE_WRITE_FAILED');
      }
      if (!await releaseWriteLock(lock)) return fail('EVIDENCE_LOCK_RELEASE_FAILED');
      return result;
    });
  }
  private async withRunQueue<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#runQueues.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolveCurrent => { release = resolveCurrent; });
    this.#runQueues.set(runId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#runQueues.get(runId) === current) this.#runQueues.delete(runId);
    }
  }
  private async verifyRunBundle(runId: string): Promise<OperationResult<VerifiedEvidenceBundle>> {
    try {
      if (!safeId(runId)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const root = await trustedRoot(this.#root);
      if (!root) return fail('EVIDENCE_INTEGRITY_FAILED');
      const runDir = resolve(root.lexical, runId);
      if (!await validatePathComponents(root, runDir, true)) return fail('EVIDENCE_INTEGRITY_FAILED');
      for (const directory of ['records', 'attachments'] as const) {
        const path = join(runDir, directory);
        const stat = await lstat(path).catch(() => null);
        if (stat && !await validatePathComponents(root, path, true)) return fail('EVIDENCE_INTEGRITY_FAILED');
      }
      const manifestBytes = await readTrustedFile(root, join(runDir, 'manifest.json'));
      if (!manifestBytes) return fail('EVIDENCE_INTEGRITY_FAILED');
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as ArtifactManifest;
      if (manifest.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(manifest.rootDigest) || !Array.isArray(manifest.entries) ||
          new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length) return fail('EVIDENCE_INTEGRITY_FAILED');
      const actual: ManifestEntry[] = [];
      const attachmentIds = new Set<string>();
      const records = new Map<string, VerifiedBundleRecord>();
      const attachments: Record<string, Buffer> = {};
      for (const entry of manifest.entries) {
        const target = containedPath(runDir, entry.path);
        if (!target) return fail('EVIDENCE_PATH_OUTSIDE_RUN');
        const bytes = await readTrustedFile(root, target);
        if (!bytes) return fail('EVIDENCE_INTEGRITY_FAILED');
        const measured: ManifestEntry = { path: entry.path, attachmentId: entry.attachmentId, bytes: bytes.byteLength, sha256: digest(bytes) };
        if (measured.bytes !== entry.bytes || measured.sha256 !== entry.sha256) return fail('EVIDENCE_INTEGRITY_FAILED');
        if (entry.attachmentId !== undefined) {
          if (!safeId(entry.attachmentId) || attachmentIds.has(entry.attachmentId) || entry.path !== `attachments/${entry.attachmentId}`) {
            return fail('EVIDENCE_DUPLICATE_ID');
          }
          attachmentIds.add(entry.attachmentId);
          attachments[entry.attachmentId] = bytes;
        } else if (entry.path.startsWith('records/') && entry.path.endsWith('.json')) {
          const id = entry.path.slice('records/'.length, -'.json'.length);
          if (!safeId(id) || records.has(id)) return fail('EVIDENCE_INTEGRITY_FAILED');
          const record = JSON.parse(bytes.toString('utf8')) as EvidenceRecord;
          if (!hasDenseValidCriteria(record) || record.id !== id || record.runId !== runId || record.schemaVersion !== 1 ||
              record.authority?.sourceStatus !== record.verifier.status) return fail('EVIDENCE_INTEGRITY_FAILED');
          records.set(id, { entry: measured, bytes, record });
        } else {
          return fail('EVIDENCE_INTEGRITY_FAILED');
        }
        actual.push(measured);
      }
      const listedPaths = new Set(manifest.entries.map(entry => entry.path));
      for (const directory of ['records', 'attachments'] as const) {
        const directoryPath = join(runDir, directory);
        const stat = await lstat(directoryPath).catch(() => null);
        if (!stat) continue;
        if (!await validatePathComponents(root, directoryPath, true)) return fail('EVIDENCE_INTEGRITY_FAILED');
        for (const name of await readdir(directoryPath)) {
          if (!listedPaths.has(`${directory}/${name}`)) return fail('EVIDENCE_INTEGRITY_FAILED');
        }
      }
      for (const { record } of records.values()) {
        if (record.closure?.status !== 'closed') return fail('EVIDENCE_RECORD_NOT_CLOSED');
        const refs = [record.stdout, record.stderr, ...(record.attachments ?? [])];
        const uniqueRefs = new Map(refs.map(ref => [ref.attachmentId, ref]));
        if (uniqueRefs.size !== refs.length) return fail('EVIDENCE_DUPLICATE_ID');
        if (uniqueRefs.size !== record.closure.attachmentIds.length || record.closure.attachmentIds.some(id => !uniqueRefs.has(id))) {
          return fail('EVIDENCE_RECORD_NOT_CLOSED');
        }
        for (const ref of uniqueRefs.values()) {
          const manifestEntry = manifest.entries.find(item => item.attachmentId === ref.attachmentId);
          if (!manifestEntry) return fail('EVIDENCE_ATTACHMENT_MISSING');
          if (manifestEntry.path !== (ref.path ?? ref.relativePath) || manifestEntry.bytes !== ref.bytes || manifestEntry.sha256 !== ref.sha256) {
            return fail('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
          }
        }
      }
      actual.sort((left, right) => left.path.localeCompare(right.path));
      const rootDigest = digest(actual.map(entry => `${entry.path}\0${entry.attachmentId ?? ''}\0${entry.bytes}\0${entry.sha256}`).join('\n'));
      if (rootDigest !== manifest.rootDigest || !await validateTrustedRoot(root)) return fail('EVIDENCE_INTEGRITY_FAILED');
      return ok({ manifest, records, attachments });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('EVIDENCE_INTEGRITY_FAILED');
      const code = (error as NodeJS.ErrnoException).code;
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_INTEGRITY_FAILED');
    }
  }
  async readVerifiedClosed(runId: string, input: EvidenceRef): Promise<OperationResult<VerifiedEvidenceReceipt>> {
    const ref = snapshotEvidenceRef(input);
    if (!safeId(runId) || !ref) return fail('EVIDENCE_INTEGRITY_FAILED');
    const verified = await this.verifyRunBundle(runId);
    if (!verified.ok) return verified;
    const recordEntry = verified.value.records.get(ref.id);
    if (!recordEntry || recordEntry.entry.sha256 !== ref.sha256 || digest(recordEntry.bytes) !== ref.sha256) return fail('EVIDENCE_INTEGRITY_FAILED');
    const record = recordEntry.record;
    if (record.id !== ref.id || record.runId !== runId || record.schemaVersion !== 1 ||
        record.authority?.sourceStatus !== record.verifier.status) return fail('EVIDENCE_INTEGRITY_FAILED');
    const receipt = Object.freeze({ record: deepFreeze(record), ref, verifiedAt: this.clock() });
    this.#receipts.add(receipt);
    return ok(receipt);
  }

  async readVerified(ref: EvidenceRef): Promise<OperationResult<VerifiedEvidenceReceipt>> {
    const snapshot = snapshotEvidenceRef(ref);
    if (!snapshot) return fail('EVIDENCE_INTEGRITY_FAILED');
    const result = await this.verifyStored(snapshot); if (!result.ok) return result;
    const receipt = Object.freeze({ record: deepFreeze(result.value), ref: snapshot, verifiedAt: this.clock() });
    this.#receipts.add(receipt); return ok(receipt);
  }
  private async verifyStored(input: EvidenceRef): Promise<OperationResult<EvidenceRecord>> {
    const ref = snapshotEvidenceRef(input);
    if (!ref) return fail('EVIDENCE_INTEGRITY_FAILED');
    try {
      if (!safeId(ref.id) || !/^[a-f0-9]{64}$/.test(ref.sha256)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const root = await trustedRoot(this.#root);
      if (!root) return fail('EVIDENCE_INTEGRITY_FAILED');
      const recordsRoot = join(root.lexical, 'records');
      const recordDir = join(recordsRoot, ref.id);
      const recordPath = join(recordDir, 'record.json');
      const attachmentRoot = join(recordDir, 'attachments');
      if (!await validatePathComponents(root, recordsRoot, true) ||
          !await validatePathComponents(root, recordDir, true) ||
          !await validatePathComponents(root, attachmentRoot, true)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const recordBytes = await readTrustedFile(root, recordPath);
      if (!recordBytes || digest(recordBytes) !== ref.sha256) return fail('EVIDENCE_INTEGRITY_FAILED');
      const record = JSON.parse(recordBytes.toString('utf8')) as EvidenceRecord;
      if (!hasDenseValidCriteria(record) || record.id !== ref.id || record.schemaVersion !== 1 || record.authority?.sourceStatus !== record.verifier.status) return fail('EVIDENCE_INTEGRITY_FAILED');
      const refs = refsOf(record);
      if (!hasExactClosure(record, refs)) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      if (new Set(refs.map(x => x.attachmentId)).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_ID_DUPLICATE');
      if (new Set(refs.map(x => x.relativePath)).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      for (const attachment of refs) {
        const target = containedPath(attachmentRoot, attachment.relativePath); if (!target) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        const present = await lstat(target).catch(() => null);
        if (!present) return fail('EVIDENCE_ATTACHMENT_MISSING');
        const bytes = await readTrustedFile(root, target);
        if (!bytes) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        if (bytes.byteLength !== attachment.bytes) return fail('EVIDENCE_ATTACHMENT_LENGTH_MISMATCH');
        if (!/^[a-f0-9]{64}$/.test(attachment.sha256) || digest(bytes) !== attachment.sha256) return fail('EVIDENCE_ATTACHMENT_HASH_MISMATCH');
      }
      const actual = await listRegularFiles(attachmentRoot), expectedSet = new Set(refs.map(x => x.relativePath));
      for (const file of actual) if (!expectedSet.has(file)) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      if (!await validateTrustedRoot(root)) return fail('EVIDENCE_INTEGRITY_FAILED');
      return ok(record);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fail('EVIDENCE_ATTACHMENT_MISSING');
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_INTEGRITY_FAILED');
    }
  }
}
