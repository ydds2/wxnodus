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
  /** KF-017：验证证据（verify() 携带——quarantine→verified 唯一通道） */
  verification?: Record<string, unknown>;
}

export interface Registry {
  add(c: Omit<Component, 'id' | 'status' | 'ts'>): string;
  list(): Component[];
  search(q: string): Component[];
  /** 状态迁移（受限）：verified 只能经 verify() 带证据进入；installed 须先 verified（不跳过检疫）；撤销（→quarantine）任意态允许 */
  setStatus(id: string, s: ComponentStatus): void;
  /** KF-017：验证门——非空证据才允许 quarantine→verified；严禁占位符伪 verified */
  verify(id: string, evidence: Record<string, unknown>): { ok: boolean; error?: string };
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
      // KF-017 状态机：verified 只能经 verify() 带证据进入——setStatus 直跳 verified 一律忽略
      if (s === 'verified') return;
      const list = load();
      const hit = list.find(c => c.id === id);
      if (!hit) return;
      // installed 须先 verified（不跳过检疫）；→quarantine（撤销）任意态允许
      if (s === 'installed' && hit.status !== 'verified') return;
      hit.status = s;
      save(list);
    },
    verify(id, evidence) {
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
        return { ok: false, error: 'FORGE_VERIFY_EVIDENCE_REQUIRED' };
      }
      const list = load();
      const hit = list.find(c => c.id === id);
      if (!hit) return { ok: false, error: 'FORGE_VERIFY_NOT_FOUND' };
      hit.status = 'verified';
      hit.verification = evidence;
      save(list);
      return { ok: true };
    },
    get(id) {
      return load().find(c => c.id === id) ?? null;
    },
  };
}
