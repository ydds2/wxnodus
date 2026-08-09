// src/store/config.ts — L1-2 配置中心：data/ 分区 json，单一事实来源
// 设计：每个分区（settings/aliases/routes/...）一个 json 文件；原子写（tmp+rename）；
//       set 增量合并；getKey/setKey 支持点路径。参考：Gemini CLI 分层配置、Claude Code settings 分区
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export type Partition = string;

export interface Config {
  get(p: Partition): Record<string, any>;
  set(p: Partition, patch: Record<string, any>): void;
  getKey(p: Partition, key: string): any;
  setKey(p: Partition, key: string, value: any): void;
  file(p: Partition): string;
}

function pathOf(dataDir: string, p: Partition): string {
  return join(dataDir, `${p}.json`);
}

function read(dataDir: string, p: Partition): Record<string, any> {
  try {
    return JSON.parse(readFileSync(pathOf(dataDir, p), 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
}

// 原子写：先写 .tmp 再 rename（防进程中断半写损坏）
function write(dataDir: string, p: Partition, obj: Record<string, any>): void {
  mkdirSync(dataDir, { recursive: true });
  const f = pathOf(dataDir, p);
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, f);
}

function deepSet(obj: Record<string, any>, path: string, value: any): void {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function deepGet(obj: Record<string, any>, path: string): any {
  return path.split('.').reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);
}

export function createConfig(dataDir: string): Config {
  return {
    get(p) { return read(dataDir, p); },
    set(p, patch) {
      const merged = { ...read(dataDir, p), ...patch };
      write(dataDir, p, merged);
    },
    getKey(p, key) { return deepGet(read(dataDir, p), key); },
    setKey(p, key, value) {
      const obj = read(dataDir, p);
      deepSet(obj, key, value);
      write(dataDir, p, obj);
    },
    file(p) { return pathOf(dataDir, p); },
  };
}

export { existsSync as configExists };
