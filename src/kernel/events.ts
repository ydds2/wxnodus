// src/kernel/events.ts — L1-3 事件总线：kernel→UI 唯一通道
// 设计：类型化事件 + 发布订阅 + append-only jsonl 持久化（审计/回放）
// 参考业界 gateway 事件流（31 种事件映射）与 hook 事件体系
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

export interface WxEvent<T = any> {
  id: string;
  type: string;
  payload: T;
  ts: number;
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
  | 'ui.confirm'
  | 'system.notice';

type Listener = (e: WxEvent) => void;

export interface EventBus {
  on(type: string, fn: Listener): () => void;
  emit(type: EventType | string, payload: any): WxEvent;
  history(): WxEvent[];
  flush(): void;
}

let seq = 0;

export function createEventBus(dataDir: string): EventBus {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'events.jsonl');
  const listeners = new Map<string, Set<Listener>>();
  const history: WxEvent[] = [];
  const HISTORY_MAX = 5000; // 内存回放上限，磁盘无上限

  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
      return () => { listeners.get(type)?.delete(fn); };
    },
    emit(type, payload) {
      const e: WxEvent = { id: `${Date.now().toString(36)}-${++seq}`, type, payload, ts: Date.now() };
      try { appendFileSync(file, JSON.stringify(e) + '\n', 'utf8'); } catch { /* 落盘失败不阻断 */ }
      history.push(e);
      if (history.length > HISTORY_MAX) history.shift();
      for (const fn of listeners.get(type) ?? []) {
        try { fn(e); } catch { /* 订阅者异常不阻断总线 */ }
      }
      return e;
    },
    history: () => [...history],
    flush() { /* 预留：批量落盘（当前同步 append 已即时） */ },
  };
}
