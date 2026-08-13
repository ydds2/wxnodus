// src/application/sessions/sessionStartGenerator.ts — SessionStart 显式生成：会话启动工件 + 原子持久化（sha256 绑定全字段）
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Locale } from '../../domain/config/configSchema.js';
import { configError } from '../../domain/config/configSchema.js';
import { validateSessionStart, type SessionStartDocument, type SessionStartHook } from '../../domain/sessions/sessionStart.js';
import type { OperationResult } from '../../protocol/results.js';

export interface SessionStartGeneratorPorts {
  locale(): Locale;
  model(): string;
  dataDir(): string;
  hooks(): SessionStartHook[];
  capabilities(): string[];
  now(): string;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};

export class SessionStartGenerator {
  constructor(private readonly ports: SessionStartGeneratorPorts) {}

  generate(sessionId: string): OperationResult<SessionStartDocument> {
    const body = {
      schemaVersion: 1 as const,
      sessionId,
      createdAt: this.ports.now(),
      locale: this.ports.locale(),
      model: this.ports.model(),
      dataDir: this.ports.dataDir(),
      hooks: this.ports.hooks(),
      capabilities: this.ports.capabilities(),
    };
    const sha256 = createHash('sha256').update(canonical(body)).digest('hex');
    return validateSessionStart({ ...body, sha256 });
  }
}

/** 原子持久化（tmp + rename）；目标目录不存在则创建 */
export async function persistSessionStart(file: string, document: SessionStartDocument): Promise<OperationResult<void>> {
  const checked = validateSessionStart(document);
  if (!checked.ok) return checked;
  try {
    const { rename } = await import('node:fs/promises');
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(temp, file);
    return { ok: true, value: undefined };
  } catch (cause) {
    return { ok: false, error: configError('SESSION_START_INVALID', 'sessionStart.persist.failed', { cause: String(cause) }) };
  }
}
