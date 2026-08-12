// src/forge/registry.ts — L3-2 组件注册表（单一事实来源 + 持久化）
// 设计：组件三态（quarantine 检疫 / verified 已验证 / installed 已安装）；JSON 落盘
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ComponentStatus = 'quarantine' | 'verified' | 'installed';

export interface Component {
  id: string;
  name: string;
  kind: 'mcp' | 'skill' | 'scaffold';
  source: string;
  version: string;
  status: ComponentStatus;
  ts: number;
}

export interface Registry {
  add(c: Omit<Component, 'id' | 'status' | 'ts'>): string;
  list(): Component[];
  search(q: string): Component[];
  setStatus(id: string, s: ComponentStatus): void;
  get(id: string): Component | null;
}

let seq = 0;

export function createRegistry(file: string): Registry {
  mkdirSync(dirname(file), { recursive: true });
  const load = (): Component[] => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  };
  const save = (list: Component[]) => writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');

  return {
    add(c) {
      const list = load();
      const id = `c${Date.now().toString(36)}${++seq}`;
      list.push({ ...c, id, status: 'quarantine', ts: Date.now() });
      save(list);
      return id;
    },
    list: () => load(),
    search(q) {
      const list = load();
      if (!q) return list;
      return list.filter(c => c.name.includes(q) || c.kind.includes(q) || c.source.includes(q));
    },
    setStatus(id, s) {
      const list = load();
      const hit = list.find(c => c.id === id);
      if (hit) { hit.status = s; save(list); }
    },
    get(id) {
      return load().find(c => c.id === id) ?? null;
    },
  };
}
