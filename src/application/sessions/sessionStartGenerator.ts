// src/application/sessions/sessionStartGenerator.ts — SessionStart 显式生成：会话启动工件 + 原子持久化（sha256 绑定全字段）
// W3 Session 第 1 步：canonical/hash 单一事实源收敛到 domain（sessionStartHash），
// generate/validate/persist/read-back 四处全部重算比对。
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Locale } from '../../domain/config/configSchema.js';
import { configError } from '../../domain/config/configSchema.js';
import {
  sessionStartHash,
  validateSessionStart,
  type SessionStartDocument,
  type SessionStartHook,
} from '../../domain/sessions/sessionStart.js';
import type { OperationResult } from '../../protocol/results.js';

export interface SessionStartGeneratorPorts {
  locale(): Locale;
  model(): string;
  dataDir(): string;
  hooks(): SessionStartHook[];
  capabilities(): string[];
  now(): string;
}

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
    const sha256 = sessionStartHash(body);
    return validateSessionStart({ ...body, sha256 });
  }
}

/** 原子持久化（tmp + rename）；目标目录不存在则创建。validate 含哈希重算比对。 */
export async function persistSessionStart(file: string, document: SessionStartDocument): Promise<OperationResult<void>> {
  const checked = validateSessionStart(document);
  if (!checked.ok) return checked;
  try {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(temp, file);
    return { ok: true, value: undefined };
  } catch (cause) {
    return { ok: false, error: configError('SESSION_START_INVALID', 'sessionStart.persist.failed', { cause: String(cause) }) };
  }
}

/** 读回重算：读文件 → parse → validate（含哈希重算比对）——磁盘篡改/半写一律拒绝 */
export async function readSessionStart(file: string): Promise<OperationResult<SessionStartDocument>> {
  try {
    const text = await readFile(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: configError('SESSION_START_INVALID', 'sessionStart.read.malformed') };
    }
    return validateSessionStart(parsed);
  } catch (cause) {
    return { ok: false, error: configError('SESSION_START_INVALID', 'sessionStart.read.failed', { cause: String(cause) }) };
  }
}
