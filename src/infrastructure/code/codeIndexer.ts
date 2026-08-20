// src/infrastructure/code/codeIndexer.ts — W7-03：黑洞同化通道 C（代码/模块扫描分块）
// 只读扫描：文本文件按「文件=块」近似分块（head=首行/符号线索，text=全文）；二进制（NUL 探测）
// 与超大文件跳过并报告；配额超限 → 部分索引 + complete:false 诚实标记（绝不假装全量）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';

export interface CodeChunk {
  source: 'code';
  /** 相对扫描根的路径（/ 分隔） */
  path: string;
  chunkIndex: number;
  /** 首行/符号线索（检索摘要） */
  head: string;
  text: string;
}

export interface ScanSkipped { path: string; reason: string }
export interface ScanReport {
  complete: boolean;
  counts: { scanned: number; indexed: number; skipped: number };
  skipped: ScanSkipped[];
}

export interface ScanOptions {
  /** 文本文件数上限（默认 1000；超限部分索引 + complete:false） */
  maxFiles?: number;
  /** 单文件字节上限（默认 1MB；更大跳过不截断——避免噪声语料） */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const BINARY_PROBE_BYTES = 512;

const isLikelyBinary = (bytes: Buffer): boolean => bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);

export function scanCodeTargets(dir: string, opts: ScanOptions = {}): OperationResult<{ chunks: CodeChunk[]; report: ScanReport }> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const chunks: CodeChunk[] = [];
  const skipped: ScanSkipped[] = [];
  let scanned = 0;
  let indexed = 0;

  const walk = (d: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const entry of entries) {
      const full = join(d, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(dir, full).split(sep).join('/');
      scanned += 1;
      if (st.size > maxFileBytes) {
        skipped.push({ path: rel, reason: `oversized ${st.size}B > ${maxFileBytes}B` });
        continue;
      }
      let bytes: Buffer;
      try { bytes = readFileSync(full); } catch { skipped.push({ path: rel, reason: 'unreadable' }); continue; }
      if (isLikelyBinary(bytes)) {
        skipped.push({ path: rel, reason: 'binary' });
        continue;
      }
      if (indexed >= maxFiles) {
        skipped.push({ path: rel, reason: `quota maxFiles=${maxFiles}` });
        continue;
      }
      const text = bytes.toString('utf8');
      const head = (text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('*')) ?? '').slice(0, 80);
      chunks.push({ source: 'code', path: rel, chunkIndex: 0, head, text });
      indexed += 1;
    }
  };
  walk(dir);

  return {
    ok: true,
    value: {
      chunks,
      report: {
        // complete = 全部可索引文件都已入索引（二进制/超大是刻意排除，不算不完整；配额截断才是）
        complete: !skipped.some(s => s.reason.startsWith('quota')),
        counts: { scanned, indexed, skipped: skipped.length },
        skipped,
      },
    },
  };
}
