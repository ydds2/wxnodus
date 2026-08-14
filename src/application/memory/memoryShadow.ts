// src/application/memory/memoryShadow.ts — W3 Memory 影子双写（决策：影子双写、观察后切换）
// agent 写消息（legacy messages）时同步影子写显式记忆记录（modern memory_records，session scope）。
// legacy append 是唯一行为事实源：影子写失败只计数、绝不上抛——观察期零行为回退。
// report 提供两模型计数与影子健康，并诚实声明召回来源（一致性验证前不回切读取源）。
import type { Memory } from '../../kernel/memory.js';
import type { MemoryRepository } from '../../domain/memory/memoryRepository.js';

export interface MemoryShadowPorts {
  /** legacy 消息记忆（唯一行为事实源） */
  legacy: Memory;
  /** modern 显式记忆仓储（影子写目标） */
  repository: Pick<MemoryRepository, 'append'>;
  /** 观察用读句柄（report 计数） */
  db: { prepare(sql: string): { get(...a: unknown[]): unknown } };
  now?(): number;
}

export interface MemoryShadowReport {
  sessionId: string;
  legacyMessages: number;
  shadowRecords: number;
  shadowAppends: number;
  shadowFailures: number;
  lastError: string | null;
  /** 观察期：召回仍走 legacy（一致性验证后另定召回策略——绝不静默回切） */
  recallSource: 'legacy';
}

export interface MemoryShadow extends Memory {
  /** 影子观察报告（/memory shadow 数据源） */
  shadowReport(sessionId: string): MemoryShadowReport;
}

export function createMemoryShadow(ports: MemoryShadowPorts): MemoryShadow {
  const { legacy, repository } = ports;
  let shadowAppends = 0;
  let shadowFailures = 0;
  let lastError: string | null = null;
  const now = ports.now ?? (() => Date.now());

  const shadowWrite = (sessionId: string, role: 'user' | 'assistant', content: string): void => {
    shadowAppends += 1;
    try {
      const result = repository.append(
        {
          role,
          content: content.slice(0, 8000),
          salience: 0.5,
          retention: { class: 'session', retainUntil: null },
          provenance: {
            sourceType: 'conversation',
            sourceId: sessionId,
            sourceUri: undefined,
            capturedAt: new Date(now()).toISOString(),
            actorId: sessionId,
            correlationId: `shadow:${sessionId}`,
            policySnapshotId: 'shadow',
            sourceTrust: 1,
          },
        },
        { sessionId },
      );
      if (!result.ok) {
        shadowFailures += 1;
        lastError = result.error.code;
      }
    } catch (cause) {
      shadowFailures += 1;
      lastError = String((cause as Error)?.message ?? cause).slice(0, 200);
    }
  };

  return {
    append(sessionId, role, content, toolCallId, parts) {
      legacy.append(sessionId, role, content, toolCallId, parts);
      // 影子写：仅 user/assistant（与 legacy 去重/向量同筛选——记忆语义，system/tool 噪音不入观察面）
      if (role === 'user' || role === 'assistant') shadowWrite(sessionId, role, String(content ?? ''));
    },
    working: (sessionId) => legacy.working(sessionId),
    recall: (sessionId) => legacy.recall(sessionId),
    recallHybrid: (query, opts) => legacy.recallHybrid(query, opts),
    setSalience: (id, mult) => legacy.setSalience(id, mult),
    listSalient: () => legacy.listSalient(),
    absorbCount: (sessionId) => legacy.absorbCount(sessionId),
    compactSmart: (sessionId, summarize) => legacy.compactSmart(sessionId, summarize),
    setTitleIfEmpty: (sessionId, title) => legacy.setTitleIfEmpty(sessionId, title),
    repository: () => legacy.repository(),
    shadowReport(sessionId) {
      const count = (sql: string, ...args: unknown[]): number => {
        try {
          const row = ports.db.prepare(sql).get(...args) as { c: number } | undefined;
          return Number(row?.c ?? 0);
        } catch { return 0; }
      };
      return {
        sessionId,
        legacyMessages: count(`SELECT COUNT(*) c FROM messages WHERE session_id=?`, sessionId),
        shadowRecords: count(
          `SELECT COUNT(*) c FROM memory_records WHERE scope_tier='session' AND scope_key=? AND tombstoned_at IS NULL`,
          sessionId,
        ),
        shadowAppends,
        shadowFailures,
        lastError,
        recallSource: 'legacy',
      };
    },
  };
}
