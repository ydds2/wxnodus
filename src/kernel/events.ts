// src/kernel/events.ts — L1-3 事件总线：kernel→UI 唯一通道
// 设计：类型化事件 + 发布订阅 + append-only jsonl 持久化（审计/回放）
// 参考业界 gateway 事件流（31 种事件映射）与 hook 事件体系
import { join } from 'node:path';
import { mkdirSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RunContext } from '../protocol/runs.js';

type RunEventScope = { context: RunContext; sealed: boolean };
const runContextStorage = new AsyncLocalStorage<RunEventScope>();

export interface WxEvent<T = any> {
  id: string;
  type: string;
  payload: T;
  ts: number;
  runId?: string;
  correlationId?: string;
  sessionId?: string;
  actorId?: string;
}

export type EventType =
  | 'agent.start'
  | 'agent.token'
  | 'agent.message'
  | 'agent.tool'
  | 'agent.stage'
  | 'agent.subagent'
  | 'agent.error'
  | 'agent.end'
  | 'run.final'
  | 'agent.goal'
  | 'reasoning.delta'
  | 'theme.changed'
  | 'system.notice'
  // 并行任务系统（taskRunner）：任务创建/完成（payload: id/kind/parent_id/status/exit_code/duration_ms）
  | 'jobs.created'
  | 'jobs.complete';

type Listener = (e: WxEvent) => void;

export interface EventBus {
  on(type: string, fn: Listener): () => void;
  emit(type: EventType | string, payload: any): WxEvent;
  /** Emit the sole terminal event for the current Run and seal inherited async work. */
  finalizeRun(payload: any): WxEvent;
  history(): WxEvent[];
  withinRun<T>(context: RunContext, operation: () => T): T;
}

let seq = 0;

export function createEventBus(dataDir: string): EventBus {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'events.jsonl');
  const listeners = new Map<string, Set<Listener>>();
  const history: WxEvent[] = [];
  const runScopes = new WeakMap<RunContext, RunEventScope>();
  const HISTORY_MAX = 5000; // 内存回放上限
  // V4 P3-3：磁盘轮转状态（自上次轮转累计字节；4MB 触发翻卷——.1 保留上一代共 ~8MB 上限）
  let writtenBytes = 0;

  const publish = (type: EventType | string, payload: any, context?: RunContext): WxEvent => {
    const e: WxEvent = {
      id: `${Date.now().toString(36)}-${++seq}`,
      type,
      payload,
      ts: Date.now(),
      ...(context ? {
        runId: context.runId,
        correlationId: context.correlationId,
        sessionId: context.sessionId,
        actorId: context.actorId,
      } : {}),
    };
    // V4 P3-3：事件流落盘分级——高频流式事件（agent.token/reasoning.delta：一次长回复
    // 数千次同步 open/write/close，Windows 上拖慢流式渲染且 events.jsonl 单日数百 MB）
    // 不落盘（内存 history 与订阅者不受影响；重放完整性由低频事件承载——message/tool/
    // stage/end 全保留）+ 4MB 轮转（.1 保留上一代——低频事件全量、重放语义完整）。
    if (type !== 'agent.token' && type !== 'reasoning.delta') {
      try {
        const line = JSON.stringify(e) + '\n';
        appendFileSync(file, line, 'utf8');
        writtenBytes += line.length;
        if (writtenBytes >= 4 * 1024 * 1024) {
          writtenBytes = 0;
          try {
            const rotated = `${file}.1`;
            try { unlinkSync(rotated); } catch { /* 无旧档 */ }
            renameSync(file, rotated);
          } catch { /* 轮转失败不阻断 */ }
        }
      } catch { /* 落盘失败不阻断 */ }
    }
    history.push(e);
    if (history.length > HISTORY_MAX) history.shift();
    for (const fn of listeners.get(type) ?? []) {
      try { fn(e); } catch { /* 订阅者异常不阻断总线 */ }
    }
    return e;
  };

  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
      return () => { listeners.get(type)?.delete(fn); };
    },
    emit(type, payload) {
      const scope = runContextStorage.getStore();
      return publish(type, payload, scope && !scope.sealed ? scope.context : undefined);
    },
    finalizeRun(payload) {
      const scope = runContextStorage.getStore();
      if (!scope || scope.sealed) return publish('run.final', payload);
      scope.sealed = true;
      return publish('run.final', payload, scope.context);
    },
    history: () => [...history],
    withinRun(context, operation) {
      let scope = runScopes.get(context);
      if (!scope) {
        scope = { context, sealed: false };
        runScopes.set(context, scope);
      }
      return runContextStorage.run(scope, operation);
    },
  };
}
