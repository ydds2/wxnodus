// src/application/sessions/sessionStartService.ts — W3 Session 第 2 步：会话启动工件服务
// 每个 session 生命周期只生成一次（in-flight 去重 + 磁盘复用 + read-back 重算）；
// 能力/hook snapshot 由 generator ports 在 generate 时刻完成，随后原子持久化。
import { existsSync } from 'node:fs';
import type { SessionStartDocument } from '../../domain/sessions/sessionStart.js';
import type { OperationResult } from '../../protocol/results.js';
import { persistSessionStart, readSessionStart, SessionStartGenerator } from './sessionStartGenerator.js';

export interface SessionStartServicePorts {
  generator: SessionStartGenerator;
  fileFor(sessionId: string): string;
}

export function createSessionStartService(ports: SessionStartServicePorts) {
  const inFlight = new Map<string, Promise<OperationResult<SessionStartDocument>>>();

  const ensure = (sessionId: string): Promise<OperationResult<SessionStartDocument>> => {
    const existing = inFlight.get(sessionId);
    if (existing) return existing;
    const promise = (async () => {
      const file = ports.fileFor(sessionId);
      // 磁盘复用：已存在则 read-back 重算（篡改拒绝——绝不静默重生成覆盖历史工件）
      if (existsSync(file)) {
        const read = await readSessionStart(file);
        if (read.ok) return read;
        // 2026-08-19 自愈：历史工件（旧字段形状/空能力清单等）字段校验失败时按当前
        // 端口重生成一次——这类失败是格式演进而非篡改（哈希不匹配仍 fail-closed，
        // 绝不静默接受被改动的文件）；重生成后 read-back 仍失败则如实上报。
        if (read.error?.code === 'SESSION_START_HASH_MISMATCH') return read;
        const generated = ports.generator.generate(sessionId);
        if (!generated.ok) return generated;
        const persisted = await persistSessionStart(file, generated.value);
        if (!persisted.ok) return persisted;
        return readSessionStart(file);
      }
      const generated = ports.generator.generate(sessionId);
      if (!generated.ok) return generated;
      const persisted = await persistSessionStart(file, generated.value);
      if (!persisted.ok) return persisted;
      // 原子持久化后 read-back 重算确认（写半程/落盘漂移即失败）
      return readSessionStart(file);
    })().finally(() => {
      inFlight.delete(sessionId);
    });
    inFlight.set(sessionId, promise);
    return promise;
  };

  return {
    ensure,
    /** 会话工件是否存在（不触发生成） */
    exists(sessionId: string): boolean {
      return existsSync(ports.fileFor(sessionId));
    },
  };
}
