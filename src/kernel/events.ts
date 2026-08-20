// src/kernel/events.ts — L1-3 事件总线：kernel→UI 唯一通道
// 设计：类型化事件 + 发布订阅 + append-only jsonl 持久化（审计/回放）
// 参考业界 gateway 事件流（31 种事件映射）与 hook 事件体系
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
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
  const HISTORY_MAX = 5000; // 内存回放上限，磁盘无上限

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
    try { appendFileSync(file, JSON.stringify(e) + '\n', 'utf8'); } catch { /* 落盘失败不阻断 */ }
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
