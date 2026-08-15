// src/store/config.ts — L1-2 配置中心：data/ 分区 json，单一事实来源
// 设计：每个分区（settings/aliases/routes/...）一个 json 文件；原子写（tmp+rename）；
//       set 增量合并；getKey/setKey 支持点路径。参考：Gemini CLI 分层配置、Claude Code settings 分区
// W2-01 legacy façade：locale precedence（cli > env > workspace > user > default）唯一事实源
// 在 ConfigService/ConfigRepository（user/config.json + workspace/.wxnodus/config.yaml）——
// 本文件的 settings 分区 `lang` 只用于运行时 /lang 切换（systemPrompt 输出规范），
// 不参与 onboarding precedence（禁止第二套 precedence）。
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

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

export class ConfigStoreError extends Error {
  constructor(
    readonly code: 'CONFIG_CORRUPT' | 'CONFIG_IO_FAILED',
    readonly path: string,
    cause?: unknown,
  ) {
    super(`${code}:${path}`, { cause });
    this.name = 'ConfigStoreError';
  }
}

function read(dataDir: string, p: Partition): Record<string, any> {
  const path = pathOf(dataDir, p);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new ConfigStoreError('CONFIG_CORRUPT', path, error);
    throw new ConfigStoreError('CONFIG_IO_FAILED', path, error);
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

// P2 配置校验：settings 分区已知键 schema——未知键 /config set 时警告（防拼写错误静默无效）
// 单一事实源：同时驱动 V3 兼容清单（src/compat/configSurface.ts）
export const SETTINGS_KEYS = new Set([
  'apiKeyEnc', 'model', 'baseURL', 'mode', 'theme', 'thinking', 'hooks', 'security',
  'lowRiskAutoApprove', 'autoResume', 'autoReview', 'webhooks', 'busy_input_mode',
  'strictMcpConfig', 'toolLazyLoad', 'budgetTokens', 'autoRepoMap',
  // 开放兼容：实际读写的键全部入白名单（此前 lang/skin/curator 被误报未知键）
  'lang', 'skin', 'curator',
  // UI 显示配置（/busy /indicator /statusbar 持久化）
  'tui_status_indicator', 'tui_statusbar',
  // A22 语音配置（voice.recordKey/vad.{silenceMs,silenceThreshold,minSpeechMs}/wakeWords/continuous）
  'voice',
  // W7/KF-004：人格（settings.personality 真实消费——进入 system prompt persona 段，不再假成功）
  'personality',
  // W7-00：主工作区（用户动态指定的项目文件夹）
  'workspace',
]);
export function unknownSettingsKeys(settings: Record<string, any>): string[] {
  return Object.keys(settings).filter(k => !SETTINGS_KEYS.has(k));
}

/** 已知配置键全表（开放兼容：/config set 放开为白名单全键，仅排除密钥槽位） */
export function knownSettingsKeys(): string[] {
  return [...SETTINGS_KEYS].filter(k => k !== 'apiKeyEnc');
}

export function createConfig(dataDir: string): Config {
  // 读快照缓存：get() 返回稳定引用（内存最新），set/setKey 写穿透同步
  // 更新同一对象——否则 /key set 等只写磁盘，持有装配时快照的 agent
  // 会继续用旧值（会话内配置不生效，重启才生效）。
  const cache = new Map<string, Record<string, any>>();

  const load = (p: Partition): Record<string, any> => {
    let obj = cache.get(p);
    if (!obj) {
      obj = read(dataDir, p);
      cache.set(p, obj);
    }
    return obj;
  };

  return {
    get(p) { return load(p); },
    set(p, patch) {
      const obj = load(p);
      Object.assign(obj, patch);
      write(dataDir, p, obj);
    },
    getKey(p, key) { return deepGet(load(p), key); },
    setKey(p, key, value) {
      const obj = load(p);
      deepSet(obj, key, value);
      write(dataDir, p, obj);
    },
    file(p) { return pathOf(dataDir, p); },
  };
}

