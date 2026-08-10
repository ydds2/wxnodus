// src/app/stores/engine.ts — 自研原子状态引擎（零第三方依赖）
// 取代 zustand + nanostores：单一引擎统一两种语义
//   ① createStore（zustand 兼容）：状态对象 + hook 订阅（useSyncExternalStore）
//   ② createAtom（nanostores 兼容）：单值原子 + get/set/subscribe/use
import { useSyncExternalStore } from 'react';

export interface WxStore<T> {
  /** React hook：订阅整个状态（zustand 语义） */
  (): T;
  getState(): T;
  setState(patch: Partial<T> | ((s: T) => T)): void;
  subscribe(fn: () => void): () => void;
  /** 非 React 订阅（带新旧值，供编排层 watch） */
  watch(fn: (s: T, prev: T) => void): () => void;
}

export function createStore<T>(initial: T | (() => T)): WxStore<T> {
  let state: T = typeof initial === 'function' ? (initial as () => T)() : initial;
  const listeners = new Set<() => void>();
  const watchers = new Set<(s: T, p: T) => void>();

  const store = (() => {
    return useSyncExternalStore(
      (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      () => state,
    );
  }) as unknown as WxStore<T>;

  store.getState = () => state;
  store.setState = (patch) => {
    const prev = state;
    const next = typeof patch === 'function' ? (patch as (s: T) => T)(prev) : { ...prev, ...patch };
    if (next === prev) return;
    state = next;
    for (const l of [...listeners]) l();
    for (const w of [...watchers]) w(state, prev);
  };
  store.subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  store.watch = (fn) => { watchers.add(fn); return () => { watchers.delete(fn); }; };
  return store;
}

export interface WxAtom<T> {
  get(): T;
  set(value: T): void;
  /** 非 React 订阅：回调收新值（nanostores 语义） */
  subscribe(fn: (v: T) => void): () => void;
  /** subscribe 别名（nanostores listen 语义，无值回调） */
  listen(fn: () => void): () => void;
  /** React hook：订阅原子值 */
  use(): T;
}

export function createAtom<T>(initial: T): WxAtom<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set: (nv) => {
      if (nv === value) return;
      value = nv;
      for (const f of [...subs]) f(value);
    },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    listen: (fn) => { const f = () => fn(); subs.add(f as unknown as (v: T) => void); return () => { subs.delete(f as unknown as (v: T) => void); }; },
    use: () => useSyncExternalStore(
      (cb) => { subs.add(cb as unknown as (v: T) => void); return () => { subs.delete(cb as unknown as (v: T) => void); }; },
      () => value,
    ),
  };
}

/** @nanostores/react useStore 替代 */
export function useAtom<T>(a: WxAtom<T>): T {
  return a.use();
}

/** 派生原子（nanostores computed 语义）：依赖变化时惰性重算 */
export function computed<T, A extends WxAtom<any>>(dep: A, fn: (v: ReturnType<A['get']>) => T): WxAtom<T>;
export function computed<T>(deps: WxAtom<any>[], fn: (...vals: any[]) => T): WxAtom<T>;
export function computed<T>(deps: WxAtom<any> | WxAtom<any>[], fn: (...vals: any[]) => T): WxAtom<T> {
  let value: T | undefined;
  let initialized = false;
  const subs = new Set<(v: T) => void>();
  const list = Array.isArray(deps) ? deps : [deps];
  const recalc = () => {
    const next = fn(...list.map(d => d.get()) as any);
    const changed = !initialized || next !== value;
    value = next;
    initialized = true;
    if (changed) for (const f of [...subs]) f(value as T);
  };
  for (const d of list) d.subscribe(() => recalc());
  recalc();
  return {
    get: () => (initialized ? (value as T) : (recalc(), value as T)),
    set: () => { throw new Error('computed 原子只读'); },
    subscribe: (fn2) => { subs.add(fn2); return () => { subs.delete(fn2); }; },
    listen: (fn2) => { const f = () => fn2(); subs.add(f as unknown as (v: T) => void); return () => { subs.delete(f as unknown as (v: T) => void); }; },
    use: () => useSyncExternalStore(
      (cb) => { subs.add(cb as unknown as (v: T) => void); return () => { subs.delete(cb as unknown as (v: T) => void); }; },
      () => (initialized ? (value as T) : (recalc(), value as T)),
    ),
  };
}
