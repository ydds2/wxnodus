// src/infrastructure/browser/harQuotaPolicy.ts — W5-02 采集配额（逐维限制 + 策略摘要）
// event/URL/session/file/directory 五维限额；超限返回结构化错误（recordEvent 拒绝 / flush 标 complete:false）。
// policyDigest = 策略参数 canonical 摘要——随落盘记录，供审计比对策略漂移。
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export interface HarQuotaPolicyOptions {
  maxEventsPerSession: number;
  maxUrlLength: number;
  maxFileBytes: number;
  maxDirectoryBytes: number;
  maxFilesPerDirectory: number;
}

export const DEFAULT_HAR_QUOTA: HarQuotaPolicyOptions = {
  maxEventsPerSession: 1000,
  maxUrlLength: 4096,
  maxFileBytes: 8 * 1024 * 1024,
  maxDirectoryBytes: 200 * 1024 * 1024,
  maxFilesPerDirectory: 100,
};

export interface HarQuotaPolicy {
  readonly options: HarQuotaPolicyOptions;
  readonly digest: string;
  checkUrl(url: string): OperationResult<void>;
  checkEventCount(current: number): OperationResult<void>;
  checkFileBytes(bytes: number): OperationResult<void>;
  checkDirectory(fileCount: number, totalBytes: number): OperationResult<void>;
}

const fail = (code: string, messageKey: string): OperationResult<never> =>
  ({ ok: false, error: configError(code, messageKey) });

export function createHarQuotaPolicy(input: Partial<HarQuotaPolicyOptions> = {}): HarQuotaPolicy {
  const options: HarQuotaPolicyOptions = { ...DEFAULT_HAR_QUOTA, ...input };
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  return {
    options,
    digest,
    checkUrl(url) {
      return url.length <= options.maxUrlLength ? { ok: true, value: undefined } : fail('HAR_QUOTA_URL_TOO_LONG', 'har.quota.url.tooLong');
    },
    checkEventCount(current) {
      return current < options.maxEventsPerSession ? { ok: true, value: undefined } : fail('HAR_QUOTA_EVENTS_EXCEEDED', 'har.quota.events.exceeded');
    },
    checkFileBytes(bytes) {
      return bytes <= options.maxFileBytes ? { ok: true, value: undefined } : fail('HAR_QUOTA_FILE_TOO_LARGE', 'har.quota.file.tooLarge');
    },
    checkDirectory(fileCount, totalBytes) {
      if (fileCount >= options.maxFilesPerDirectory || totalBytes >= options.maxDirectoryBytes) {
        return fail('HAR_QUOTA_DIRECTORY_EXCEEDED', 'har.quota.directory.exceeded');
      }
      return { ok: true, value: undefined };
    },
  };
}
