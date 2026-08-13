// src/infrastructure/quality/fileEvidenceStore.ts — 不可变 evidence 存储：输入校验 → 临时目录 → readback → 原子 rename → 只读
// W3-01 扩展：appendClosed/appendBundle/verifyIntegrity(runId) 的 run bundle 布局（manifest + records + attachments），
// 与 W1-09 的 per-record 布局/WeakSet 收据信任模型并存——receipt 只能由本 store 实例签发（owns），不引入 trusted 字段。
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DeepReadonly, EvidenceAttachment, EvidenceAttachmentRef, EvidenceRecord, EvidenceRef, VerifiedEvidenceReceipt } from '../../domain/quality/evidence.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); }
  return value as DeepReadonly<T>;
}
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const fail = <T = never>(code: string): OperationResult<T> => err(gatewayError(code, code, `evidence.${code.toLowerCase()}`));
// 函数声明形式：TS 对显式 never 返回的函数声明做 CFA 收窄（guard 后 target 直接可用）
function raise(code: string): never { throw Object.assign(new Error(code), { code }); }
// W3-01：run bundle 布局的 manifest 契约（与 per-record 布局并存）
export interface ManifestEntry { path: string; attachmentId?: string; bytes: number; sha256: string }
export interface ArtifactManifest { algorithm: 'sha256'; rootDigest: string; entries: ManifestEntry[] }
interface EvidenceBundle { runId: string; records: EvidenceRecord[]; attachments: Record<string, Buffer> }
async function durableWrite(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
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
  verifyIntegrity(ref: EvidenceRef): Promise<OperationResult<EvidenceRef>>;
  /** W3-01：run bundle 级完整性——重读实际 bytes（不信任落盘 hash），闭包/篡改 fail closed */
  verifyIntegrity(runId: string): Promise<OperationResult<ArtifactManifest>>;
  verifyIntegrity(target: EvidenceRef | string): Promise<OperationResult<EvidenceRef | ArtifactManifest>> {
    return typeof target === 'string' ? this.verifyRunBundle(target) : this.verifyStored(target).then(result => result.ok ? ok(target) : result);
  }
  /** W3-01：EvidenceService 闭合通道——closure 校验 + 全量附件 hash/length/path 核对后原子换入 run bundle */
  async appendClosed(record: EvidenceRecord, pending: readonly { attachmentId: string; bytes: Buffer }[]): Promise<OperationResult<{ evidenceId: string }>> {
    if (!safeId(record.id) || !safeId(record.runId)) return fail('EVIDENCE_WRITE_FAILED');
    if (record.closure?.status !== 'closed') return fail('EVIDENCE_RECORD_NOT_CLOSED');
    if (new Set(pending.map(item => item.attachmentId)).size !== pending.length) return fail('EVIDENCE_DUPLICATE_ID');
    if (pending.some(item => !/^[A-Za-z0-9._-]+$/.test(item.attachmentId))) return fail('EVIDENCE_PATH_OUTSIDE_RUN');
    const refs = [record.stdout, record.stderr, ...(record.attachments ?? [])];
    const refIds = refs.map(ref => ref.attachmentId);
    if (new Set(refIds).size !== refs.length) return fail('EVIDENCE_DUPLICATE_ID');
    const closureIds = record.closure.attachmentIds;
    if (closureIds.length !== refIds.length || closureIds.some(id => !refIds.includes(id))) return fail('EVIDENCE_RECORD_NOT_CLOSED');
    const byId = new Map(pending.map(item => [item.attachmentId, item]));
    for (const ref of refs) {
      const input = byId.get(ref.attachmentId);
      if (!input) return fail('EVIDENCE_ATTACHMENT_MISSING');
      if ((ref.path ?? ref.relativePath) !== `attachments/${ref.attachmentId}`) return fail('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
      if (!/^[a-f0-9]{64}$/.test(ref.sha256) || digest(input.bytes) !== ref.sha256) return fail('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
      if (input.bytes.byteLength !== ref.bytes) return fail('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
    }
    const current = await this.readBundle(record.runId);
    if (!current.ok) return current;
    if (current.value.records.some(item => item.id === record.id) ||
        pending.some(item => Object.hasOwn(current.value.attachments, item.attachmentId))) return fail('EVIDENCE_DUPLICATE_ID');
    const attachments = { ...current.value.attachments };
    for (const item of pending) attachments[item.attachmentId] = Buffer.from(item.bytes);
    const written = await this.appendBundle({ runId: record.runId, records: [...current.value.records, record], attachments });
    return written.ok ? ok({ evidenceId: record.id }) : written;
  }
  /** W3-01：整捆原子写入（manifest 根摘要 + 排序条目），目录换入 rollback-safe，每个文件 sync 后 rename */
  async appendBundle(bundle: EvidenceBundle): Promise<OperationResult<{ evidenceId: string }>> {
    if (!safeId(bundle.runId)) return fail('EVIDENCE_WRITE_FAILED');
    if (new Set(bundle.records.map(record => record.id)).size !== bundle.records.length) return fail('EVIDENCE_DUPLICATE_ID');
    const finalDir = join(this.root, bundle.runId);
    const tempDir = join(this.root, `.${bundle.runId}.${randomUUID()}.tmp`);
    const backupDir = join(this.root, `.${bundle.runId}.${randomUUID()}.bak`);
    let movedOld = false;
    try {
      await mkdir(tempDir, { recursive: true });
      const entries: ManifestEntry[] = [];
      for (const record of bundle.records) {
        const path = `records/${record.id}.json`;
        const bytes = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
        await durableWrite(join(tempDir, ...path.split('/')), bytes);
        entries.push({ path, bytes: bytes.byteLength, sha256: digest(bytes) });
      }
      for (const [name, bytes] of Object.entries(bundle.attachments)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) raise('EVIDENCE_WRITE_FAILED');
        const path = `attachments/${name}`;
        await durableWrite(join(tempDir, ...path.split('/')), bytes);
        entries.push({ path, attachmentId: name, bytes: bytes.byteLength, sha256: digest(bytes) });
      }
      entries.sort((left, right) => left.path.localeCompare(right.path));
      const rootDigest = digest(entries.map(entry => `${entry.path}\0${entry.attachmentId ?? ''}\0${entry.bytes}\0${entry.sha256}`).join('\n'));
      const manifest: ArtifactManifest = { algorithm: 'sha256', rootDigest, entries };
      await durableWrite(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await mkdir(this.root, { recursive: true });
      try { await rename(finalDir, backupDir); movedOld = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(tempDir, finalDir);
      if (movedOld) await rm(backupDir, { recursive: true, force: true });
      return ok({ evidenceId: bundle.records.at(-1)?.id ?? `bundle-${bundle.runId}` });
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (movedOld) {
        await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
        try { await rename(backupDir, finalDir); } catch { return fail('EVIDENCE_WRITE_FAILED'); }
      }
      const code = (error as NodeJS.ErrnoException).code;
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_WRITE_FAILED');
    }
  }
  private async verifyRunBundle(runId: string): Promise<OperationResult<ArtifactManifest>> {
    try {
      if (!safeId(runId)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const runDir = resolve(this.root, runId);
      const manifest = JSON.parse(await readFile(resolve(runDir, 'manifest.json'), 'utf8')) as ArtifactManifest;
      if (manifest.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(manifest.rootDigest) ||
          new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length) return fail('EVIDENCE_INTEGRITY_FAILED');
      const actual: ManifestEntry[] = [];
      const attachmentIds = new Set<string>();
      for (const entry of manifest.entries) {
        const target = containedPath(runDir, entry.path);
        if (!target) return fail('EVIDENCE_PATH_OUTSIDE_RUN');
        const bytes = await readFile(target);
        const measured: ManifestEntry = { path: entry.path, attachmentId: entry.attachmentId, bytes: bytes.byteLength, sha256: digest(bytes) };
        // 篡改检测：实际字节/长度与 manifest 不符 → 整体完整性失败（绝不信任自报 pass）
        if (measured.bytes !== entry.bytes || measured.sha256 !== entry.sha256) return fail('EVIDENCE_INTEGRITY_FAILED');
        if (entry.attachmentId !== undefined) {
          if (attachmentIds.has(entry.attachmentId) || entry.path !== `attachments/${entry.attachmentId}`) return fail('EVIDENCE_DUPLICATE_ID');
          attachmentIds.add(entry.attachmentId);
        }
        actual.push(measured);
      }
      // 目录闭包：不允许 manifest 之外的多余游离文件
      const listedPaths = new Set(manifest.entries.map(entry => entry.path));
      for (const directory of ['records', 'attachments'] as const) {
        try {
          for (const name of await readdir(join(runDir, directory))) {
            if (!listedPaths.has(`${directory}/${name}`)) return fail('EVIDENCE_INTEGRITY_FAILED');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      // 闭包记录：closure 必须为 closed，且 attachmentIds 与 record 引用精确一致、与 manifest 实际条目核对
      for (const entry of actual.filter(item => item.path.startsWith('records/'))) {
        const record = JSON.parse(await readFile(resolve(runDir, entry.path), 'utf8')) as EvidenceRecord;
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
      return rootDigest === manifest.rootDigest ? ok(manifest) : fail('EVIDENCE_INTEGRITY_FAILED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('EVIDENCE_INTEGRITY_FAILED');
      const code = (error as NodeJS.ErrnoException).code;
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_INTEGRITY_FAILED');
    }
  }
  private async readBundle(runId: string): Promise<OperationResult<EvidenceBundle>> {
    const runDir = join(this.root, runId);
    try {
      const records: EvidenceRecord[] = [];
      for (const name of await readdir(join(runDir, 'records'))) {
        records.push(JSON.parse(await readFile(join(runDir, 'records', name), 'utf8')) as EvidenceRecord);
      }
      const attachments: Record<string, Buffer> = {};
      try {
        for (const name of await readdir(join(runDir, 'attachments'))) {
          attachments[name] = await readFile(join(runDir, 'attachments', name));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return ok({ runId, records, attachments });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ok({ runId, records: [], attachments: {} });
      return fail('EVIDENCE_INTEGRITY_FAILED');
    }
  }
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
