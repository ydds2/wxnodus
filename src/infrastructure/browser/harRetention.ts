// src/infrastructure/browser/harRetention.ts — W5-02 留存策略（只删 owned 文件）
// 目录扫描只认 session-<SAFE_ID>.har（owned 模式）——外来文件/子目录/其他后缀绝不动；
// 超龄优先删 + 数量上限兜底（最旧先删）。
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export const OWNED_HAR_FILE = /^session-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.har$/;

export interface HarRetentionOptions {
  maxFiles: number;
  maxAgeMs: number;
  now?: () => number;
}

export function applyHarRetention(dir: string, options: HarRetentionOptions): OperationResult<{ deleted: number }> {
  try {
    const now = options.now ?? Date.now;
    const owned = readdirSync(dir)
      .filter(name => OWNED_HAR_FILE.test(name))
      .map(name => {
        const full = join(dir, name);
        return { full, mtimeMs: statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧在前
    let deleted = 0;
    for (const file of owned) {
      const agedOut = now() - file.mtimeMs > options.maxAgeMs;
      const overCount = owned.length - deleted > options.maxFiles;
      if (!agedOut && !overCount) break; // 已排序：之后的更新
      try { unlinkSync(file.full); deleted++; } catch { /* 单文件删除失败不阻断（审计由调用方负责） */ }
    }
    return { ok: true, value: { deleted } };
  } catch (cause) {
    return { ok: false, error: configError('HAR_RETENTION_FAILED', 'har.retention.failed', { cause: String(cause) }) };
  }
}
