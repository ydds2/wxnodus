// src/infrastructure/quality/fileEvidenceStore.ts — 不可变 evidence 存储：输入校验 → 临时目录 → readback → 原子 rename → 只读
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DeepReadonly, EvidenceAttachment, EvidenceAttachmentRef, EvidenceRecord, EvidenceRef, VerifiedEvidenceReceipt } from '../../domain/quality/evidence.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); }
  return value as DeepReadonly<T>;
}
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const fail = <T = never>(code: string): OperationResult<T> => err(gatewayError(code, code, `evidence.${code.toLowerCase()}`));
// 函数声明形式：TS 对显式 never 返回的函数声明做 CFA 收窄（guard 后 target 直接可用）
function raise(code: string): never { throw Object.assign(new Error(code), { code }); }
const refsOf = (record: EvidenceRecord): EvidenceAttachmentRef[] => [record.stdout, record.stderr];
function containedPath(base: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const target = resolve(base, ...relativePath.split('/')), rel = relative(base, target);
  return !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : target;
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
  constructor(private readonly root: string, private readonly clock: () => string = () => new Date().toISOString()) {}
  owns(receipt: unknown): receipt is VerifiedEvidenceReceipt { return typeof receipt === 'object' && receipt !== null && this.#receipts.has(receipt); }
  async append(record: EvidenceRecord, attachments: readonly EvidenceAttachment[]): Promise<OperationResult<EvidenceRef>> {
    if (!safeId(record.id) || !safeId(record.runId)) return fail('EVIDENCE_WRITE_FAILED');
    const refs = refsOf(record), refIds = refs.map(x => x.attachmentId), refPaths = refs.map(x => x.relativePath), inputIds = attachments.map(x => x.attachmentId);
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
    const recordsRoot = join(this.root, 'records'), finalDir = join(recordsRoot, record.id);
    const tempDir = join(recordsRoot, `.tmp-${record.id}-${randomUUID()}`), attachmentRoot = join(tempDir, 'attachments');
    try {
      await mkdir(attachmentRoot, { recursive: true });
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
  async verifyIntegrity(ref: EvidenceRef): Promise<OperationResult<EvidenceRef>> { const result = await this.verifyStored(ref); return result.ok ? ok(ref) : result; }
  async readVerified(ref: EvidenceRef): Promise<OperationResult<VerifiedEvidenceReceipt>> {
    const result = await this.verifyStored(ref); if (!result.ok) return result;
    const receipt = Object.freeze({ record: deepFreeze(result.value), ref: Object.freeze({ ...ref }), verifiedAt: this.clock() });
    this.#receipts.add(receipt); return ok(receipt);
  }
  private async verifyStored(ref: EvidenceRef): Promise<OperationResult<EvidenceRecord>> {
    try {
      if (!safeId(ref.id) || !/^[a-f0-9]{64}$/.test(ref.sha256)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const recordDir = join(this.root, 'records', ref.id), recordPath = join(recordDir, 'record.json'), recordHandle = await open(recordPath, 'r');
      let recordBytes: Buffer;
      try { const stat = await recordHandle.stat(); if (!stat.isFile()) return fail('EVIDENCE_INTEGRITY_FAILED'); recordBytes = await recordHandle.readFile(); }
      finally { await recordHandle.close(); }
      if (digest(recordBytes) !== ref.sha256) return fail('EVIDENCE_INTEGRITY_FAILED');
      const record = JSON.parse(recordBytes.toString('utf8')) as EvidenceRecord;
      if (record.id !== ref.id || record.schemaVersion !== 1 || record.authority?.sourceStatus !== record.verifier.status) return fail('EVIDENCE_INTEGRITY_FAILED');
      const refs = refsOf(record);
      if (new Set(refs.map(x => x.attachmentId)).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_ID_DUPLICATE');
      if (new Set(refs.map(x => x.relativePath)).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      const attachmentRoot = join(recordDir, 'attachments'), realRoot = await realpath(attachmentRoot).catch(() => null); if (!realRoot) return fail('EVIDENCE_ATTACHMENT_MISSING');
      // 逐项校验：缺失 → MISSING（先于闭包集合比较——缺失文件不再误报 CLOSURE_INVALID）
      for (const attachment of refs) {
        const target = containedPath(attachmentRoot, attachment.relativePath); if (!target) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        const stat = await lstat(target).catch(() => null); if (!stat) return fail('EVIDENCE_ATTACHMENT_MISSING'); if (!stat.isFile() || stat.isSymbolicLink()) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        const realTarget = await realpath(target), rel = relative(realRoot, realTarget); if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        const handle = await open(target, 'r');
        try { const opened = await handle.stat(), bytes = await handle.readFile(); if (!opened.isFile() || opened.size !== attachment.bytes || bytes.byteLength !== attachment.bytes) return fail('EVIDENCE_ATTACHMENT_LENGTH_MISMATCH'); if (!/^[a-f0-9]{64}$/.test(attachment.sha256) || digest(bytes) !== attachment.sha256) return fail('EVIDENCE_ATTACHMENT_HASH_MISMATCH'); }
        finally { await handle.close(); }
      }
      // 闭包：不允许多出游离文件（expected ⊆ actual 已由上一步保证存在性）
      const actual = await listRegularFiles(attachmentRoot), expectedSet = new Set(refs.map(x => x.relativePath));
      for (const file of actual) if (!expectedSet.has(file)) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      return ok(record);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fail('EVIDENCE_ATTACHMENT_MISSING');
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_INTEGRITY_FAILED');
    }
  }
}
