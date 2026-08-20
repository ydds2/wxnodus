// src/kernel/profiles.ts — 接入档案（多厂商/中转站）单一事实源
// 设计：providers[] 档案（id/name/baseURL/models/key/balanceUrl/balancePath）；
//       无档案时按 baseURL 回退 MODEL_CATALOG 派生档案（兼容旧配置）；
//       模型名校验放开——任意非空模型名直接可用（「接口不开放」根因修复：
//       此前 agent.ts/cli 用 MODEL_CATALOG.some() 强制回退目录外模型名）。
import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_CATALOG, detectProvider } from './providers.js';
import { FALLBACK_MODEL } from './defaults.js';
import { resolveDataDir } from './paths.js';

export interface ProviderProfile {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
  key?: string;
  balanceUrl?: string;
  balancePath?: string;
}

/** 目录派生的内置档案（余额接口预置） */
const CATALOG_BALANCE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/user/balance',
  kimi: 'https://api.moonshot.cn/v1/users/me/balance',
  // zhipu：无密钥可查余额接口——留空，状态栏诚实不显示（/balance status 说明原因）
};

function catalogProfileFor(provider: string): ProviderProfile {
  const entries = MODEL_CATALOG.filter(m => m.provider === provider && !m.modelId.startsWith('offline:'));
  const models = entries.map(m => m.modelId);
  const baseURL = entries[0]?.baseURL ?? '';
  return {
    id: provider,
    name: entries[0]?.name ?? provider,
    baseURL,
    models,
    balanceUrl: CATALOG_BALANCE_URLS[provider] ?? '',
  };
}

export function resolveProviderProfile(settings: Record<string, any>): { profile: ProviderProfile; source: 'providers' | 'catalog' | 'legacy' } | null {
  const providers: ProviderProfile[] = Array.isArray(settings?.providers) ? settings.providers : [];
  const active = String(settings?.activeProvider ?? '');
  if (active) {
    const hit = providers.find(p => p.id === active);
    if (hit) return { profile: hit, source: 'providers' };
  }
  const baseURL = String(settings?.baseURL ?? '');
  const provider = detectProvider(baseURL);
  if (provider !== 'openai-compatible') return { profile: catalogProfileFor(provider), source: 'catalog' };
  // 遗留配置：自定义 baseURL（中转站）但没有档案 → 虚拟档案
  const model = String(settings?.model ?? '');
  return {
    profile: { id: 'custom', name: '自定义端点', baseURL: baseURL || '', models: model ? [model] : [], balanceUrl: '', balancePath: '' },
    source: 'legacy',
  };
}

export function defaultModelForProfile(p: ProviderProfile): string {
  return p.models[0] ?? '';
}

/** 模型名解析（根因修复）：任意非空模型名直接可用；空→档案默认→内置默认 */
export function resolveModelForChat(settings: Record<string, any>): string {
  const model = String(settings?.model ?? '').trim();
  if (model) return model;
  const prof = resolveProviderProfile(settings);
  if (prof) {
    const d = defaultModelForProfile(prof.profile);
    if (d) return d;
  }
  return FALLBACK_MODEL;
}

/** 旧 apiKeyEnc/apiKeys/model/baseURL → providers[0] 迁移（备份原 settings.json） */
export function migrateLegacyProviderSettings(config: { get: (k: string) => any; setKey: (a: string, b: string, v: unknown) => void }): { migrated: boolean; backupFile?: string } {
  const s = (config.get('settings') ?? {}) as Record<string, any>;
  if (Array.isArray(s.providers)) return { migrated: false };
  const hasLegacy = s.apiKeyEnc || s.baseURL || s.model || (s.apiKeys && Object.keys(s.apiKeys).length);
  if (!hasLegacy) return { migrated: false };
  const baseURL = String(s.baseURL ?? '');
  const provider = detectProvider(baseURL);
  const catalogModels = provider !== 'openai-compatible'
    ? MODEL_CATALOG.filter(m => m.provider === provider && !m.modelId.startsWith('offline:')).map(m => m.modelId)
    : (s.model ? [String(s.model)] : []);
  const profile: ProviderProfile = {
    id: provider !== 'openai-compatible' ? provider : 'custom',
    name: provider !== 'openai-compatible' ? (MODEL_CATALOG.find(m => m.provider === provider)?.name ?? provider) : '自定义端点',
    baseURL: baseURL || 'https://api.deepseek.com/v1',
    models: catalogModels,
    key: String((s.apiKeys && s.apiKeys[provider]) ?? s.apiKeyEnc ?? ''),
    balanceUrl: CATALOG_BALANCE_URLS[provider] ?? '',
    balancePath: '',
  };
  const backupFile = `settings.backup-${Date.now()}.json`;
  try {
    const dataDir = resolveDataDir(process.cwd());
    const file = join(dataDir, 'settings.json');
    if (existsSync(file)) copyFileSync(file, join(dataDir, backupFile));
  } catch { /* 备份失败不阻断迁移 */ }
  config.setKey('settings', 'providers', [profile]);
  config.setKey('settings', 'activeProvider', profile.id);
  if (!s.model || !String(s.model).trim()) config.setKey('settings', 'model', catalogModels[0] ?? '');
  return { migrated: true, backupFile };
}

// ── 档案健康检查（/doctor 数据源——配置漂移防呆：纯函数可单测）──
export interface ProfileHealthIssue {
  kind: 'active-missing' | 'bad-base-url' | 'duplicate-id';
  id?: string;
  detail: string;
}

export function profileHealth(providers: Array<Record<string, any>> | undefined | null, activeProvider: string | null | undefined): ProfileHealthIssue[] {
  const list = Array.isArray(providers) ? providers : [];
  const issues: ProfileHealthIssue[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    const id = typeof p?.id === 'string' ? p.id.trim() : '';
    if (!id) {
      issues.push({ kind: 'duplicate-id', detail: '档案缺少 id' });
      continue;
    }
    if (seen.has(id)) issues.push({ kind: 'duplicate-id', id, detail: `档案 id 重复：${id}` });
    seen.add(id);
    if (!/^https?:\/\//i.test(String(p?.baseURL ?? ''))) issues.push({ kind: 'bad-base-url', id, detail: `档案 ${id} 的 baseURL 非 http(s)` });
  }
  if (activeProvider && list.length && !list.some(p => p?.id === activeProvider)) {
    issues.push({ kind: 'active-missing', id: activeProvider, detail: `activeProvider 指向不存在的档案：${activeProvider}` });
  }
  return issues;
}
