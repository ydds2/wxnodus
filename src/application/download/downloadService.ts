// src/application/download/downloadService.ts — W7-01：下载框架
// 流式原子落盘（tmp + fsync + rename，中断零残留）→ sha256 证据；Content-Length 预拒绝 +
// 真实字节双上限；文件名三源（显式/Content-Disposition/URL basename）全过 sanitize；
// 逐跳授权（SSRF 由 authorizeUrl 端口承接——生产接 outboundTargetPolicy）fail-closed。
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { basename, join } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import { validateWorkspaceTarget } from '../../infrastructure/fs/pathBoundary.js';

export const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

/** 文件名 sanitize：只取 basename（剥目录穿越）、替换非法字符、Windows 保留名加 _ 前缀、空名兜底 */
export function sanitizeDownloadFilename(raw: string): string {
  const base = basename(String(raw ?? '').trim()).replace(UNSAFE_NAME_CHARS, '_');
  const name = base || 'download';
  const stem = name.split('.')[0]!.toUpperCase();
  return WINDOWS_RESERVED.has(stem) ? `_${name}` : name;
}

/** Content-Disposition → filename（引号/裸值/缺失） */
export function filenameFromContentDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(header);
  const raw = match?.[1] ?? match?.[2];
  return raw ? raw.trim() : undefined;
}

export interface DownloadRequest {
  url: string;
  /** 主工作区根（W7-00）——destDir 必须在其内 */
  workspaceRoot: string;
  /** 工作区内目标目录（不存在则创建） */
  destDir: string;
  fileName?: string;
  maxBytes?: number;
}

export interface DownloadResult {
  filePath: string;
  fileName: string;
  bytes: number;
  sha256: string;
}

export interface DownloadPorts {
  /** 逐跳授权（生产：outboundTargetPolicy/SSRF 三层；拒绝 → DOWNLOAD_URL_BLOCKED） */
  authorizeUrl(url: string): Promise<{ ok: boolean; reason?: string }>;
  /** 单跳 fetch（无自动重定向；3xx 由 downloadFile 解析 location 后重新授权） */
  fetchOnce(url: string): Promise<{ status: number; headers: Record<string, string>; body: Readable }>;
  /** 完成证据（生产：toolEvidenceStore 原子落盘） */
  evidence?(bundle: { url: string; filePath: string; bytes: number; sha256: string; completedAt: string }): void;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const headerOf = (headers: Record<string, string>, name: string): string | undefined => {
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
};

type SizeLimitError = Error & { sizeLimit: true };

export async function downloadFile(request: DownloadRequest, ports: DownloadPorts): Promise<OperationResult<DownloadResult>> {
  const boundary = await validateWorkspaceTarget(request.workspaceRoot, request.destDir);
  if (!boundary.ok) {
    return { ok: false, error: configError('BUILD_PATH_OUTSIDE_WORKSPACE', 'path.boundary.outside', { path: request.destDir }) };
  }
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;

  // 逐跳授权 + 重定向上限（绝不静默跟随未经授权的下一跳）
  let currentUrl = request.url;
  for (let hop = 0; ; hop += 1) {
    const allowed = await ports.authorizeUrl(currentUrl);
    if (!allowed.ok) {
      return { ok: false, error: configError('DOWNLOAD_URL_BLOCKED', 'download.url.blocked', { url: currentUrl, reason: allowed.reason }) };
    }
    let response: { status: number; headers: Record<string, string>; body: Readable };
    try {
      response = await ports.fetchOnce(currentUrl);
    } catch (cause) {
      return { ok: false, error: configError('DOWNLOAD_STREAM_FAILED', 'download.stream.failed', { url: currentUrl, cause: String((cause as Error).message ?? cause) }) };
    }
    if (REDIRECT_STATUS.has(response.status)) {
      response.body.destroy();
      const location = headerOf(response.headers, 'location');
      if (!location) {
        return { ok: false, error: configError('DOWNLOAD_HTTP_ERROR', 'download.http.error', { url: currentUrl, status: response.status }) };
      }
      if (hop >= MAX_REDIRECTS) {
        return { ok: false, error: configError('DOWNLOAD_TOO_MANY_REDIRECTS', 'download.redirect.limit', { url: request.url }) };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      response.body.destroy();
      return { ok: false, error: configError('DOWNLOAD_HTTP_ERROR', 'download.http.error', { url: currentUrl, status: response.status }) };
    }

    // 双上限之一：Content-Length 预拒绝（零字节落盘）
    const declared = Number(headerOf(response.headers, 'content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.body.destroy();
      return { ok: false, error: configError('DOWNLOAD_SIZE_LIMIT', 'download.size.limit', { url: currentUrl, bytes: declared, maxBytes }) };
    }

    // 文件名三源：显式 > Content-Disposition > URL basename——全部 sanitize
    const rawName = request.fileName ?? filenameFromContentDisposition(headerOf(response.headers, 'content-disposition')) ?? basename(new URL(currentUrl).pathname);
    const fileName = sanitizeDownloadFilename(rawName);

    try {
      mkdirSync(request.destDir, { recursive: true });
    } catch (cause) {
      response.body.destroy();
      return { ok: false, error: configError('DOWNLOAD_DEST_UNAVAILABLE', 'download.dest.unavailable', { destDir: request.destDir, cause: String((cause as Error).message ?? cause) }) };
    }
    const finalPath = join(request.destDir, fileName);
    const tmpPath = join(request.destDir, `.${fileName}.${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let bytes = 0;
    const cleanup = () => rmSync(tmpPath, { force: true });

    // 流式写入 tmp（真实字节上限 + 中断零残留——绝不落半成品到最终路径）
    try {
      await new Promise<void>((resolveStream, rejectStream) => {
        const fd = openSync(tmpPath, 'w');
        let done = false;
        const finish = (err?: Error): void => {
          if (done) return;
          done = true;
          if (err) {
            response.body.destroy();
            try { closeSync(fd); } catch { /* 句柄已关 */ }
            rejectStream(err);
          }
        };
        response.body.on('data', (chunk: Buffer) => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            finish(Object.assign(new Error('size-limit'), { sizeLimit: true }) as SizeLimitError);
            return;
          }
          hash.update(chunk);
          try { writeSync(fd, chunk); } catch (cause) { finish(cause as Error); }
        });
        response.body.on('end', () => {
          if (done) return;
          try { fsyncSync(fd); closeSync(fd); } catch (cause) { finish(cause as Error); return; }
          done = true;
          resolveStream();
        });
        response.body.on('error', (err) => finish(err));
      });
    } catch (cause) {
      cleanup();
      if ((cause as SizeLimitError).sizeLimit) {
        return { ok: false, error: configError('DOWNLOAD_SIZE_LIMIT', 'download.size.limit', { url: currentUrl, maxBytes }) };
      }
      return { ok: false, error: configError('DOWNLOAD_STREAM_FAILED', 'download.stream.failed', { url: currentUrl, cause: String((cause as Error).message ?? cause) }) };
    }

    // 原子提交：rename 到最终名；失败清理 tmp
    try {
      renameSync(tmpPath, finalPath);
    } catch (cause) {
      cleanup();
      return { ok: false, error: configError('DOWNLOAD_COMMIT_FAILED', 'download.commit.failed', { cause: String((cause as Error).message ?? cause) }) };
    }
    const sha256 = hash.digest('hex');
    ports.evidence?.({ url: currentUrl, filePath: finalPath, bytes, sha256, completedAt: new Date().toISOString() });
    return { ok: true, value: { filePath: finalPath, fileName, bytes, sha256 } };
  }
}

/** 下载证据原子落盘（sha256 绑定 + 读回自校验——与 fileEvidenceStore 同款约束） */
export function writeDownloadEvidence(dataDir: string, bundle: { url: string; filePath: string; bytes: number; sha256: string; completedAt: string }): void {
  const dir = join(dataDir, 'evidence', 'downloads');
  mkdirSync(dir, { recursive: true });
  const body = { schemaVersion: 1, ...bundle };
  const record = { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  const file = join(dir, `download-${bundle.completedAt.replace(/[:.]/g, '-')}-${bundle.sha256.slice(0, 8)}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
