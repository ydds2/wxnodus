// src/kernel/diffReviewed.ts — /diff mark-reviewed 持久化（2026-08-19 ③ 残留收口）
// opencode diff-viewer mark-reviewed 对标：逐 hunk 审阅标记，跨会话持久化。
// 指纹 = sha256(hunk header + 正文)——内容变更即失效（审阅状态不跟随漂移，诚实）。
// 存储：dataDir/diff-reviewed.json { [绝对路径]: { [指纹]: true } }——小 JSON 直读直写。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ParsedHunk } from './hunkApply.js';

const storePath = (dataDir: string) => join(dataDir, 'diff-reviewed.json');

export function hunkFingerprint(h: ParsedHunk): string {
  return createHash('sha256').update(h.header + '\n').digest('hex');
}

export interface DiffReviewedStore { marks: Record<string, Record<string, boolean>> }

export function loadDiffReviewed(dataDir: string): DiffReviewedStore {
  const p = storePath(dataDir);
  try {
    if (!existsSync(p)) return { marks: {} };
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { marks?: Record<string, Record<string, boolean>> };
    return { marks: (raw?.marks && typeof raw.marks === 'object') ? raw.marks : {} };
  } catch { return { marks: {} }; }
}

export function markHunkReviewed(dataDir: string, absFile: string, fingerprint: string): void {
  const store = loadDiffReviewed(dataDir);
  store.marks[absFile] = { ...(store.marks[absFile] ?? {}), [fingerprint]: true };
  try {
    mkdirSync(dirname(storePath(dataDir)), { recursive: true });
    writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2), 'utf8');
  } catch { /* 持久化失败不阻断审阅流程（内存态已生效） */ }
}

export function isHunkReviewed(dataDir: string, absFile: string, fingerprint: string): boolean {
  return Boolean(loadDiffReviewed(dataDir).marks[absFile]?.[fingerprint]);
}
