// src/kernel/modelRegistry.ts — 模型注册表（/model add 与 model.add RPC 共享写入逻辑）
// 开放兼容：任意 OpenAI 兼容端点（厂商直连/中转站）经 /model add 或选择器「＋ 添加自定义接口」
// 落地为 settings.providers 档案（activeProvider 激活 + baseURL/model 同步）；密钥 AES-256-GCM 加密落盘。
// /key 已并入 /model：applyModelKey 是唯一密钥写入路径（命令面 + 选择器 key 段同源）。
import { detectProvider, encryptKey } from './providers.js';
import { resolveDefaultModel, resolveDefaultBaseURL } from './defaults.js';

/** /model add 解析结果（纯函数可单测） */
export interface ParsedModelAdd {
  /** 去重后的模型 ID 列表（逗号分隔输入） */
  modelIds: string[];
  /** OpenAI 兼容端点（必须 http(s)://） */
  baseURL: string;
  /** 显示名（缺省取第一个模型 ID） */
  name: string;
  /** 可选密钥（加密落盘，绝不回显） */
  key?: string;
}

/** /model add <模型ID[,ID2]> --base <URL> [--name 名称] [--key 密钥] */
export function parseModelAddArgs(args: string[]): ParsedModelAdd | null {
  const models: string[] = [];
  let baseURL = '';
  let name = '';
  let key: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] ?? '').trim();
    if (!a) continue;
    if (a === '--base' || a === '-b') { baseURL = String(args[i + 1] ?? '').trim(); i++; continue; }
    if (a === '--name' || a === '-n') { name = String(args[i + 1] ?? '').trim(); i++; continue; }
    if (a === '--key' || a === '-k') { key = String(args[i + 1] ?? '').trim(); i++; continue; }
    if (a.startsWith('--')) continue;
    models.push(...a.split(',').map(s => s.trim()).filter(Boolean));
  }
  if (!models.length || !/^https?:\/\//i.test(baseURL)) return null;
  return { modelIds: [...new Set(models)], baseURL, name: name || models[0]!, ...(key ? { key } : {}) };
}

/** 档案 id 净化（^[a-z0-9_-]{1,40}；全非法字符回退 custom） */
export function sanitizeProfileId(name: string): string {
  const s = String(name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'custom';
}

/** 最小配置端口（commands ctx.config 与 gateway kernel.config 结构同构） */
export interface ModelRegistryPort {
  getKey(path: string, key: string): unknown;
  setKey(path: string, key: string, value: unknown): void;
}

/** settings.providers 条目最小形状（kernel/profiles ProviderProfile 的子集） */
export interface ProviderProfileLite {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
  key?: string;
  balanceUrl?: string;
  balancePath?: string;
}

/**
 * 添加自定义接口：upsert 档案（id 重名自动 -2/-3 去重）+ 激活 + 审计。
 * audit 注入（commands 层传 appendAudit；gateway 同款）——失败静默由调用方兜底。
 */
export function addCustomModel(
  cfg: ModelRegistryPort,
  parsed: ParsedModelAdd,
  audit?: (event: string, payload: Record<string, unknown>) => void,
): { id: string; message: string } {
  const providers = (Array.isArray(cfg.getKey('settings', 'providers')) ? cfg.getKey('settings', 'providers') : []) as ProviderProfileLite[];
  const base = sanitizeProfileId(parsed.name);
  let id = base;
  let n = 2;
  while (providers.some(p => p.id === id)) id = `${base}-${n++}`;
  const profile: ProviderProfileLite = {
    id,
    name: parsed.name,
    baseURL: parsed.baseURL,
    models: parsed.modelIds,
    ...(parsed.key ? { key: encryptKey(parsed.key) } : {}),
  };
  cfg.setKey('settings', 'providers', [...providers, profile]);
  cfg.setKey('settings', 'activeProvider', id);
  cfg.setKey('settings', 'baseURL', parsed.baseURL);
  cfg.setKey('settings', 'model', parsed.modelIds[0]!);
  audit?.('model.add', { id, baseURL: parsed.baseURL, models: parsed.modelIds });
  return {
    id,
    message: `已添加自定义接口「${parsed.name}」（档案 ${id}）：${parsed.modelIds.join('、')} @ ${parsed.baseURL}，已切换为 ${parsed.modelIds[0]}${parsed.key ? '（密钥已加密存储）' : '——未配密钥：/model set-key 或选择器内 ^k 配置'}\n${MODEL_SWITCH_CACHE_NOTICE}`,
  };
}

/**
 * V4 P4-6（W-5 品类痛点 15）：会话中切换模型的缓存代价提示。
 * 切模型 → provider 前缀缓存全失效 + 输出分布漂移——首次响应变慢且上下文
 * 按未命中价重计（缓存节省归零）。切换点统一附注（目录命中/档案命中/add 自动切换）；
 * 状态栏缓存节省展示已有（保持）。
 */
export const MODEL_SWITCH_CACHE_NOTICE = '⚠ 切换模型后缓存前缀失效：首次响应会变慢（上下文按未命中价重新计费，缓存节省从零累积）';

/** 密钥写入选项：profileId=档案密钥槽（并激活）；provider=目录厂商槽位（apiKeys 归属） */
export interface ModelKeyOptions {
  profileId?: string;
  provider?: string;
}

/** 密钥写入（原 /key set 迁移）：档案 → 写档案 key 槽并激活；否则写 apiKeys 槽 + 遗留单槽 */
export function applyModelKey(cfg: ModelRegistryPort, secret: string, opts: ModelKeyOptions = {}): string {
  const enc = encryptKey(secret);
  if (opts.profileId) {
    const providers = (Array.isArray(cfg.getKey('settings', 'providers')) ? cfg.getKey('settings', 'providers') : []) as ProviderProfileLite[];
    const hit = providers.find(p => p.id === opts.profileId);
    if (!hit) return `档案不存在：${opts.profileId}（/profile list 查看）`;
    cfg.setKey('settings', 'providers', providers.map(p => (p.id === opts.profileId ? { ...p, key: enc } : p)));
    // 密钥与端点配对：激活该档案（baseURL 同步；model 缺省取档案第一个模型）
    cfg.setKey('settings', 'activeProvider', opts.profileId);
    cfg.setKey('settings', 'baseURL', hit.baseURL);
    if (!cfg.getKey('settings', 'model')) cfg.setKey('settings', 'model', hit.models?.[0] ?? resolveDefaultModel({}));
    return `密钥已配置到档案 ${opts.profileId}（AES-256-GCM 加密存储，绝不回显）`;
  }
  const provider = opts.provider ?? detectProvider(String(cfg.getKey('settings', 'baseURL') ?? ''));
  const apiKeys = { ...((cfg.getKey('settings', 'apiKeys') as Record<string, string> | undefined) ?? {}) };
  apiKeys[provider] = enc;
  cfg.setKey('settings', 'apiKeys', apiKeys);
  cfg.setKey('settings', 'apiKeyEnc', enc);           // 遗留单槽（向后兼容旧版本读取）
  cfg.setKey('settings', 'keyProvider', provider);    // 归属标注（错配即 fail-closed）
  // 补默认模型/端点：配置密钥即视为已配置（与旧 /key set 同口径）
  if (!cfg.getKey('settings', 'model')) cfg.setKey('settings', 'model', resolveDefaultModel({}));
  if (!cfg.getKey('settings', 'baseURL')) cfg.setKey('settings', 'baseURL', resolveDefaultBaseURL({}));
  return `密钥已配置（provider=${provider}，AES-256-GCM 加密存储，绝不回显）`;
}
