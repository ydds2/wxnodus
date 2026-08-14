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
