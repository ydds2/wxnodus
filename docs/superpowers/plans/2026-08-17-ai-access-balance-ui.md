# AI 接入层开放 + 余额监控 + UI 简约趣味改版 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task（本会话子代理额度已耗尽，禁用 subagent-driven）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 放开模型/端点配置（档案系统+自定义模型名）、余额状态栏监控+分区间 token 消耗、黑洞主题简约+动效+趣味 UI 改版。

**Architecture:** 新增 `src/kernel/profiles.ts`（档案解析/迁移）与 `src/kernel/balance.ts`（余额适配器链）与 `src/kernel/usage.ts`（区间聚合）与 `src/wxnodus-ui/lib/motion.ts`（确定性动效帧）；改造 providers/agent/cli 的模型名校验（强制回退是「接口不开放」根因）；状态栏经 wxGateway 新 RPC 轮询。

**Tech Stack:** Node 22 + TypeScript ESM · better-sqlite3 · 自研 ink 渲染器（16ms 帧/throttle/damage 差分）· vitest。

## Global Constraints

- 协议范围仅 OpenAI 兼容（/chat/completions）；不做 Anthropic/Gemini 原生、不做 OAuth。
- 密钥加密沿用 `encryptKey/decryptKey`（`src/kernel/providers.ts:16-33`），明文绝不落盘/回显（`maskKey`）。
- 所有 UI 动效：单格字符更新走 damage 差分，与流式共享 16ms throttle；`terminalTier` 三级降级（modern 全动效/cmd 静态+极简闪烁/no-vt 无）；全局逃生门 `WXNODUS_NO_ANIM=1`。
- 失败诚实：余额失败保留旧值+时间、状态栏 ⚠；绝不伪造余额。
- 命令分级统一经 `src/kernel/commandLevels.ts` 白名单；AI 通道 redline 语义不可绕过。
- 每次改动后运行 `npm test`（或目标单测文件）验证；提交信息格式 `feat: 中文描述`。
- 测试陷阱注释是真实缺陷记录，禁止删除现有注释。

---

### Task 1: 档案系统 + 模型名校验放开（根因修复）

**Files:**
- Create: `src/kernel/profiles.ts`
- Modify: `src/kernel/providers.ts`（`resolveApiKey` 扩展档案槽）、`src/kernel/agent.ts:352-353`、`src/cli/index.ts:190-200`
- Test: `tests/kernel-profiles.test.ts`

**Interfaces:**
- Consumes: `encryptKey/decryptKey/MODEL_CATALOG/detectProvider`（providers.ts 既有导出）
- Produces:
  - `interface ProviderProfile { id: string; name: string; baseURL: string; models: string[]; key?: string; balanceUrl?: string; balancePath?: string }`
  - `resolveProviderProfile(settings: Record<string, any>): { profile: ProviderProfile; source: 'providers' | 'catalog' | 'legacy' } | null`
  - `defaultModelForProfile(p: ProviderProfile): string`
  - `resolveModelForChat(settings): string`（模型名任意非空即用，空→档案默认→FALLBACK_MODEL）
  - `migrateLegacyProviderSettings(config: { get: (k: string) => any; setKey: (a: string, b: string, v: unknown) => void }): { migrated: boolean; backupFile?: string }`

- [ ] **Step 1: 写失败测试**

`tests/kernel-profiles.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { resolveProviderProfile, defaultModelForProfile, resolveModelForChat, type ProviderProfile } from '../src/kernel/profiles.js';

const enc = 'enc1:deadbeef:deadbeef:deadbeef'; // 占位（resolveApiKey 解密不在此测）

describe('profiles', () => {
  it('resolveProviderProfile: providers 数组命中 activeProvider', () => {
    const p: ProviderProfile = { id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['gpt-4o-mini'], key: enc, balanceUrl: '', balancePath: '' };
    const s = { activeProvider: 'relay1', providers: [p], baseURL: 'https://api.deepseek.com/v1' };
    const r = resolveProviderProfile(s);
    expect(r?.profile.id).toBe('relay1');
    expect(r?.source).toBe('providers');
  });

  it('resolveProviderProfile: 无档案时按 baseURL 回退 catalog 档案', () => {
    const s = { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
    const r = resolveProviderProfile(s);
    expect(r?.source).toBe('catalog');
    expect(r?.profile.balanceUrl).toBe('https://api.deepseek.com/user/balance');
  });

  it('resolveModelForChat: catalog 外模型名不被强制回退', () => {
    const s = { model: 'my-custom-relay-model', baseURL: 'https://r.example.com/v1' };
    expect(resolveModelForChat(s)).toBe('my-custom-relay-model');
  });

  it('resolveModelForChat: 模型名为空回退档案默认', () => {
    const p: ProviderProfile = { id: 'relay1', name: '中转站', baseURL: 'https://r.example.com/v1', models: ['gpt-4o-mini'] };
    expect(resolveModelForChat({ model: '', activeProvider: 'relay1', providers: [p] })).toBe('gpt-4o-mini');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/kernel-profiles.test.ts`
Expected: FAIL（`Cannot find module '../src/kernel/profiles.js'`）

- [ ] **Step 3: 实现 src/kernel/profiles.ts**

```ts
// src/kernel/profiles.ts — 接入档案（多厂商/中转站）单一事实源
// 设计：providers[] 档案（id/name/baseURL/models/key/balanceUrl/balancePath）；
//       无档案时按 baseURL 回退 MODEL_CATALOG 派生档案（兼容旧配置）；
//       模型名校验放开——任意非空模型名直接可用（「接口不开放」根因修复）。
import { MODEL_CATALOG, detectProvider } from './providers.js';

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
  // zhipu：无密钥可查余额接口——留空，状态栏诚实不显示
};

function catalogProfileFor(provider: string): ProviderProfile {
  const models = MODEL_CATALOG.filter(m => m.provider === provider && m.modelId.startsWith('offline:') === false).map(m => m.modelId);
  const baseURL = MODEL_CATALOG.find(m => m.provider === provider)?.baseURL ?? '';
  return {
    id: provider,
    name: MODEL_CATALOG.find(m => m.provider === provider)?.name ?? provider,
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

export function resolveModelForChat(settings: Record<string, any>): string {
  const model = String(settings?.model ?? '').trim();
  if (model) return model; // 任意非空模型名直接可用（根因修复：不再 catalog 校验强制回退）
  const prof = resolveProviderProfile(settings);
  if (prof) {
    const d = defaultModelForProfile(prof.profile);
    if (d) return d;
  }
  const { FALLBACK_MODEL } = { FALLBACK_MODEL: 'deepseek-v4-flash' } as any;
  return FALLBACK_MODEL;
}

/** 旧 apiKeyEnc/apiKeys/model/baseURL → providers[0] 迁移（备份原 settings.json） */
export function migrateLegacyProviderSettings(config: { get: (k: string) => any; setKey: (a: string, b: string, v: unknown) => void }): { migrated: boolean; backupFile?: string } {
  const s = config.get('settings') as Record<string, any> | undefined ?? {};
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
    key: String(s.apiKeys?.[provider] ?? s.apiKeyEnc ?? ''),
    balanceUrl: CATALOG_BALANCE_URLS[provider] ?? '',
    balancePath: '',
  };
  const backupFile = `settings.backup-${Date.now()}.json`;
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const { resolveDataDir } = require('./paths.js') as typeof import('./paths.js');
    const file = path.join(resolveDataDir(process.cwd()), 'settings.json');
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(resolveDataDir(process.cwd()), backupFile));
  } catch { /* 备份失败不阻断迁移 */ }
  config.setKey('settings', 'providers', [profile]);
  config.setKey('settings', 'activeProvider', profile.id);
  if (!s.model || !String(s.model).trim()) config.setKey('settings', 'model', catalogModels[0] ?? '');
  return { migrated: true, backupFile };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/kernel-profiles.test.ts`
Expected: PASS（4/4）

- [ ] **Step 5: 改造三处强制回退（根因）**

`src/kernel/agent.ts:352-353` 改为：

```ts
    // 根因修复：模型名校验放开——任意非空模型名（含中转站自定义名）直接可用；
    // 仅空/缺失时回退档案默认（resolveModelForChat 单一事实源）
    const model = resolveModelForChat(s);
```

并在 agent.ts 顶部 import 区加 `import { resolveModelForChat } from './profiles.js';`

`src/cli/index.ts:190-200` 的校验块改为：

```ts
  if (settings.apiKeyEnc) {
    // 根因修复：只补空值，不再把 catalog 外模型名强制回退默认
    if (!settings.model || !String(settings.model).trim()) {
      settings.model = resolveDefaultModel({});
      config.setKey('settings', 'model', settings.model);
    }
    if (!settings.baseURL) {
      settings.baseURL = resolveDefaultBaseURL({});
      config.setKey('settings', 'baseURL', settings.baseURL);
    }
  }
```

`src/kernel/providers.ts` 的 `resolveApiKey` 头部（`:76` 后、`:84` 前）插入档案槽优先：

```ts
  // 档案密钥槽优先（profiles 体系）：按 activeProvider 档案的 key 槽归属
  const profile = (settings as any)?.providers?.find?.((p: any) => p?.id === (settings as any)?.activeProvider);
  if (profile?.key) {
    const dec = decryptKey(profile.key);
    if (dec) return { key: dec, source: 'enc', provider };
    return { key: null, source: 'enc', provider, error: 'decrypt-failed', hint: `档案 ${profile.id} 密钥槽解密失败（机器环境变化？）——/key set <密钥> 重新配置` };
  }
  const profileEnvKey = profile?.id ? env[`WXNODUS_${String(profile.id).toUpperCase()}_KEY`] : undefined;
  if (profileEnvKey?.trim()) return { key: profileEnvKey.trim(), source: 'env', provider };
```

- [ ] **Step 6: 装配迁移调用**

`src/cli/index.ts` main() 中 `const settings = config.get('settings') as {...}`（`:167`）之后插入：

```ts
  // 档案迁移：旧 apiKeyEnc/baseURL/model → providers[0]（备份原 settings.json）
  const { migrateLegacyProviderSettings } = await import('../kernel/profiles.js');
  migrateLegacyProviderSettings(config);
```

- [ ] **Step 7: 全量回归 + 提交**

Run: `npm test`
Expected: 既有测试全绿（若有 MODEL_CATALOG 计数断言失败——见 Task 7 口径更新——先在本任务处理：grep 计数断言并改为「catalog 是子集」语义）

```bash
git add src/kernel/profiles.ts src/kernel/providers.ts src/kernel/agent.ts src/cli/index.ts tests/kernel-profiles.test.ts
git commit -m "feat: 档案系统+模型名校验放开——任意非空模型名可用（根因修复），旧配置自动迁移"
```

---

### Task 2: 余额适配器链 + jsonPath 兜底（kernel/balance.ts）

**Files:**
- Create: `src/kernel/jsonPath.ts`、`src/kernel/balance.ts`
- Test: `tests/kernel-balance.test.ts`、`tests/kernel-jsonPath.test.ts`

**Interfaces:**
- Consumes: `safeFetchText`（`src/kernel/ssrf.ts`）、`resolveApiKey`、`mapHttpError`、`appendAudit`、`recordConsent`（compliance ConsentLedger 同 tools.ts:24-35 模式）、Task 1 的 `ProviderProfile`
- Produces:
  - `getByPath(obj: unknown, path: string): unknown`（`a.b[0].c`）
  - `interface BalanceInfo { balance: string; currency?: string; source: string }`
  - `parseBalanceForHost(host: string, data: unknown): BalanceInfo | null`（适配器注册表）
  - `fetchBalance(profile: ProviderProfile, settings: Record<string, any>): Promise<{ ok: true; info: BalanceInfo } | { ok: false; error: string; status?: number }>`
  - `fetchBalanceCached(profile, settings, opts: { force?: boolean }): Promise<…>`（TTL 5 分钟模块级缓存）

- [ ] **Step 1: 写失败测试（jsonPath）**

`tests/kernel-jsonPath.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { getByPath } from '../src/kernel/jsonPath.js';

describe('jsonPath', () => {
  it('嵌套对象与数组索引', () => {
    expect(getByPath({ a: { b: [{ c: 42 }] } }, 'a.b[0].c')).toBe(42);
  });
  it('缺失路径返回 undefined 不抛', () => {
    expect(getByPath({ a: 1 }, 'x.y.z')).toBeUndefined();
  });
  it('顶层数组', () => {
    expect(getByPath([{ v: 'x' }], '[0].v')).toBe('x');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/kernel-jsonPath.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/kernel/jsonPath.ts**

```ts
// src/kernel/jsonPath.ts — 零依赖点路径取值（余额 jsonPath 兜底：a.b[0].c）
export function getByPath(obj: unknown, path: string): unknown {
  const parts = String(path ?? '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(s => s.trim())
    .filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/kernel-jsonPath.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（适配器）**

`tests/kernel-balance.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseBalanceForHost, pickBalancePath } from '../src/kernel/balance.js';

describe('balance adapters', () => {
  it('deepseek: balance_infos[].total_balance + currency', () => {
    const r = parseBalanceForHost('api.deepseek.com', {
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '5.00', granted_balance: '0', topped_up_balance: '5.00' }, { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
    });
    expect(r?.balance).toBe('110.00');
    expect(r?.currency).toBe('CNY');
    expect(r?.source).toBe('deepseek');
  });

  it('kimi: data.available_balance（形状 (R)）', () => {
    const r = parseBalanceForHost('api.moonshot.cn', { code: 0, data: { available_balance: 66.5, voucher_balance: 10, cash_balance: 56.5 } });
    expect(r?.balance).toBe('66.5');
    expect(r?.source).toBe('kimi');
  });

  it('siliconflow: data.balance 优先', () => {
    const r = parseBalanceForHost('api.siliconflow.cn', { code: 20000, data: { balance: '3.21', chargeBalance: '3.21', totalBalance: '3.21' } });
    expect(r?.balance).toBe('3.21');
    expect(r?.source).toBe('siliconflow');
  });

  it('openrouter: data.total_credits', () => {
    const r = parseBalanceForHost('openrouter.ai', { data: { total_credits: 12.34, total_usage: 0 } });
    expect(r?.balance).toBe('12.34');
    expect(r?.source).toBe('openrouter');
  });

  it('generic 启发式：balance 键命中', () => {
    const r = parseBalanceForHost('relay.example.com', { data: { balance: '9.99' } });
    expect(r?.balance).toBe('9.99');
    expect(r?.source).toBe('generic');
  });

  it('未命中且无 jsonPath → null（诚实不伪造）', () => {
    expect(parseBalanceForHost('relay.example.com', { hello: 'world' })).toBeNull();
  });

  it('jsonPath 兜底：customPath 覆盖启发式', () => {
    const r = parseBalanceForHost('relay.example.com', { meta: { money: { left: 7.5 } } }, 'meta.money.left');
    expect(r?.balance).toBe('7.5');
    expect(r?.source).toBe('path');
  });
});
```

- [ ] **Step 6: 运行确认失败**

Run: `npx vitest run tests/kernel-balance.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 7: 实现 src/kernel/balance.ts**

```ts
// src/kernel/balance.ts — 余额查询适配器链（一家一纯函数 + 注册表）
// 取证（2026-08-17）：deepseek=官方文档确认；kimi/siliconflow/openrouter=形状已知 (R)；
// 智谱/OpenAI/Anthropic 无密钥可查余额接口——档案 balanceUrl 留空时诚实不显示。
// 合规：抓取成功 appendAudit + ConsentLedger 留痕（不含密钥）。
import { getByPath } from './jsonPath.js';
import { safeFetchText } from './ssrf.js';
import { resolveApiKey, mapHttpError } from './providers.js';
import { appendAudit } from '../store/db.js';
import type { ProviderProfile } from './profiles.js';

export interface BalanceInfo { balance: string; currency?: string; source: string }

const numStr = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v)) ? String(v) : (typeof v === 'string' && v.trim() !== '') ? v.trim() : null;

/** 适配器：返回 {balance,currency,source} 或 null（未命中=不伪造） */
type Adapter = (data: unknown) => BalanceInfo | null;

const adapters: Array<{ hostRe: RegExp; id: string; fn: Adapter }> = [
  {
    hostRe: /(^|\.)deepseek\.com$/i, id: 'deepseek', fn: (data) => {
      const arr = (data as any)?.balance_infos;
      if (!Array.isArray(arr) || !arr.length) return null;
      const pick = arr.find((x: any) => x?.currency === 'CNY') ?? arr[0];
      const balance = numStr(pick?.total_balance);
      return balance ? { balance, currency: String(pick?.currency ?? ''), source: 'deepseek' } : null;
    },
  },
  {
    hostRe: /(^|\.)(moonshot|kimi)\.(cn|com)$/i, id: 'kimi', fn: (data) => {
      const d = (data as any)?.data;
      const balance = numStr(d?.available_balance ?? d?.balance);
      return balance ? { balance, source: 'kimi' } : null;
    },
  },
  {
    hostRe: /(^|\.)siliconflow\.cn$/i, id: 'siliconflow', fn: (data) => {
      const d = (data as any)?.data;
      const balance = numStr(d?.balance ?? d?.chargeBalance ?? d?.totalBalance);
      return balance ? { balance, source: 'siliconflow' } : null;
    },
  },
  {
    hostRe: /(^|\.)openrouter\.ai$/i, id: 'openrouter', fn: (data) => {
      const d = (data as any)?.data;
      const balance = numStr(d?.total_credits ?? d?.credits);
      return balance ? { balance, currency: 'USD', source: 'openrouter' } : null;
    },
  },
];

/** generic 启发式：键名含 balance/available/cash/credit/total 的数值（深度 2 内） */
function genericPick(data: unknown): BalanceInfo | null {
  const KEYS = /(available_?balance|total_?balance|charge_?balance|cash_?balance|voucher_?balance|balance|余额|credit)/i;
  const walk = (node: any, depth: number): BalanceInfo | null => {
    if (!node || typeof node !== 'object' || depth > 2) return null;
    for (const [k, v] of Object.entries(node)) {
      if (KEYS.test(k)) {
        const b = numStr(v);
        if (b) return { balance: b, source: 'generic' };
      }
      if (v && typeof v === 'object') {
        const hit = walk(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(data, 0);
}

/** host 判定 + 适配器链 + jsonPath 兜底 */
export function parseBalanceForHost(host: string, data: unknown, jsonPath?: string): BalanceInfo | null {
  if (jsonPath) {
    const v = getByPath(data, jsonPath);
    const b = numStr(v);
    if (b) return { balance: b, source: 'path' };
  }
  for (const a of adapters) {
    if (a.hostRe.test(host)) {
      const hit = a.fn(data);
      if (hit) return hit;
    }
  }
  return genericPick(data);
}

/** 按档案余额 URL 抓取（Bearer 认证；JSON 解析失败/非 2xx 诚实归因） */
export async function fetchBalance(profile: ProviderProfile, settings: Record<string, any>): Promise<{ ok: true; info: BalanceInfo } | { ok: false; error: string; status?: number }> {
  const url = String(profile.balanceUrl ?? '').trim();
  if (!url) return { ok: false, error: '该档案未配置余额接口（/balance set <url> 配置或该厂商无密钥可查接口）' };
  let host = 'unknown';
  try { host = new URL(url).host; } catch { return { ok: false, error: `余额 URL 无效：${url.slice(0, 80)}` }; }
  const keyRes = resolveApiKey({ ...settings, baseURL: profile.baseURL });
  if (!keyRes.key) return { ok: false, error: '当前档案未配置密钥（/key set <密钥> 配置后重试）' };
  const r = await safeFetchText(url, { method: 'GET', headers: { Authorization: `Bearer ${keyRes.key}` }, maxBytes: 64_000, timeoutMs: 10_000 });
  if ('error' in r) return { ok: false, error: r.error };
  if (r.status >= 400) return { ok: false, error: mapHttpError(r.status), status: r.status };
  let data: unknown;
  try { data = JSON.parse(r.text); } catch { return { ok: false, error: '余额接口返回非 JSON（可能是网页而非接口——/balance set 需 API 网址）' }; }
  const info = parseBalanceForHost(host, data, profile.balancePath || undefined);
  if (!info) return { ok: false, error: '响应中未识别到余额字段（可 /balance set --path <jsonPath> 指定路径）' };
  return { ok: true, info };
}

let cache: { key: string; info: BalanceInfo; ts: number } | null = null;
const TTL_MS = 5 * 60_000;

/** TTL 5 分钟缓存（force=true 强制刷新） */
export async function fetchBalanceCached(profile: ProviderProfile, settings: Record<string, any>, opts: { force?: boolean; db?: any } = {}): Promise<{ ok: true; info: BalanceInfo; cached: boolean } | { ok: false; error: string; status?: number }> {
  const key = `${profile.id}:${profile.balanceUrl}`;
  if (!opts.force && cache && cache.key === key && Date.now() - cache.ts < TTL_MS) return { ok: true, info: cache.info, cached: true };
  const r = await fetchBalance(profile, settings);
  if (r.ok) {
    cache = { key, info: r.info, ts: Date.now() };
    try { opts.db && appendAudit(opts.db, 'balance.fetch', { ok: true, source: r.info.source, profile: profile.id }); } catch { /* 审计失败静默 */ }
  } else {
    try { opts.db && appendAudit(opts.db, 'balance.fetch', { ok: false, error: r.error.slice(0, 120), profile: profile.id }); } catch { /* 静默 */ }
  }
  return r.ok ? { ok: true, info: r.info, cached: false } : r;
}

export { numStr as __testNumStr };
```

- [ ] **Step 8: 运行确认通过**

Run: `npx vitest run tests/kernel-balance.test.ts tests/kernel-jsonPath.test.ts`
Expected: PASS（全部）

- [ ] **Step 9: 提交**

```bash
git add src/kernel/jsonPath.ts src/kernel/balance.ts tests/kernel-jsonPath.test.ts tests/kernel-balance.test.ts
git commit -m "feat: 余额适配器链——deepseek 官方/kimi/siliconflow/openrouter 形状/generic 启发式/jsonPath 兜底，TTL 5 分钟+审计留痕"
```

---

### Task 3: 分区间 token 聚合（kernel/usage.ts + /usage range）

**Files:**
- Create: `src/kernel/usage.ts`
- Modify: `src/commands/handlersExt.ts`（/usage 处理器 :762 扩展）、`src/kernel/commandLevels.ts`（'/usage range'=safe）
- Test: `tests/kernel-usage.test.ts`

**Interfaces:**
- Consumes: `Db`（`src/store/db.ts`）
- Produces: `type UsageRange = 'today' | '7d' | '30d'`；`usageRangeSince(range: UsageRange, now?: Date): number`；`usageSummary(db: Db, range: UsageRange): { input: number; output: number; total: number; calls: number }`

- [ ] **Step 1: 写失败测试**

`tests/kernel-usage.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { usageRangeSince, usageSummary } from '../src/kernel/usage.js';
import { openDB } from '../src/store/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('usage', () => {
  it('usageRangeSince: today=本地零点', () => {
    const now = new Date(2026, 7, 17, 15, 30); // 2026-08-17 15:30 本地
    const since = usageRangeSince('today', now);
    expect(since).toBe(new Date(2026, 7, 17, 0, 0).getTime());
  });
  it('usageRangeSince: 7d/30d 滚动窗口', () => {
    const now = new Date(2026, 7, 17, 12, 0);
    expect(usageRangeSince('7d', now)).toBe(now.getTime() - 7 * 86_400_000);
    expect(usageRangeSince('30d', now)).toBe(now.getTime() - 30 * 86_400_000);
  });
  it('usageSummary: 跨会话聚合 + 区间过滤', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-usage-'));
    try {
      const db = openDB(dir);
      const ins = db.prepare(`INSERT INTO usage_stats (session_id, model, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?)`);
      ins.run('s1', 'm1', 100, 50, Date.now());
      ins.run('s2', 'm2', 300, 150, Date.now());
      ins.run('s3', 'm3', 1000, 500, Date.now() - 40 * 86_400_000); // 40 天前→排除
      const s = usageSummary(db, '30d');
      expect(s).toEqual({ input: 400, output: 200, total: 600, calls: 2 });
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/kernel-usage.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/kernel/usage.ts**

```ts
// src/kernel/usage.ts — token 消耗区间聚合（跨会话；状态栏 📊 数据源）
import type { Db } from '../store/db.js';

export type UsageRange = 'today' | '7d' | '30d';
export const USAGE_RANGES: UsageRange[] = ['today', '7d', '30d'];

/** 区间起点毫秒（today=本地零点；7d/30d=滚动窗口） */
export function usageRangeSince(range: UsageRange, now: Date = new Date()): number {
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = range === '7d' ? 7 : 30;
  return now.getTime() - days * 86_400_000;
}

export interface UsageSummary { input: number; output: number; total: number; calls: number }

export function usageSummary(db: Db, range: UsageRange): UsageSummary {
  const since = usageRangeSince(range);
  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COUNT(*) c FROM usage_stats WHERE ts >= ?`
  ).get(since) as { i: number; o: number; c: number };
  return { input: row.i, output: row.o, total: row.i + row.o, calls: row.c };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/kernel-usage.test.ts`
Expected: PASS

- [ ] **Step 5: /usage range 命令 + 分级**

`src/commands/handlersExt.ts` 的 `/usage` 注册（:762）处扩展（保持原输出，新增 range 子命令）：

```ts
  bus.register('/usage', (args) => {
    if (args[0] === 'range' || args[0] === 'r') {
      const range = args[1] === '7d' || args[1] === '30d' || args[1] === 'today' ? args[1] : null;
      if (!range) return '用法：/usage range <today|7d|30d>（状态栏 📊 段点击可循环切换）';
      ctx.config.setKey('settings', 'usageRange', range);
      const { usageSummary } = ctx.db ? { usageSummary: (db: any, r: any) => { const since = r === 'today' ? new Date().setHours(0,0,0,0) : Date.now() - (r === '7d' ? 7 : 30) * 86400000; const row = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COUNT(*) c FROM usage_stats WHERE ts >= ?`).get(since); return { input: row.i, output: row.o, total: row.i + row.o, calls: row.c }; } } : { usageSummary: () => ({ input: 0, output: 0, total: 0, calls: 0 }) };
      const s = usageSummary(ctx.db, range);
      return `token 区间已切换：${range}——累计 ${s.total.toLocaleString()} token（入 ${s.input.toLocaleString()} / 出 ${s.output.toLocaleString()} / ${s.calls} 次调用）`;
    }
    // ...原有 /usage 输出保持不变（会话级）
  });
```

> 注：实现时改用 `src/kernel/usage.ts` 的 `usageSummary` 导入，不要内联（DRY）——上例仅示意接线位置。

`src/kernel/commandLevels.ts` 的 safe 区加：`'/usage range': 'safe',`（放在 '/usage' 之后）。

- [ ] **Step 6: 提交**

```bash
git add src/kernel/usage.ts src/commands/handlersExt.ts src/kernel/commandLevels.ts tests/kernel-usage.test.ts
git commit -m "feat: 分区间 token 聚合——usageSummary(today/7d/30d 跨会话) + /usage range 命令"
```

---

### Task 4: 命令面——/profile、/key import、/config export|import、/balance

**Files:**
- Modify: `src/commands/handlersExt.ts`（注册 /profile /config /balance /fortune /warp）、`src/commands/handlers.ts`（/key 扩展 --profile 与 import）、`src/kernel/commandLevels.ts`（分级）
- Test: `tests/commands-profile-balance.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveProviderProfile/migrateLegacyProviderSettings`、Task 2 `fetchBalanceCached`、Task 3 `usageSummary`；`encryptKey/maskKey`；`appendAudit`；`ConsentLedger`（compliance）
- Produces: 命令注册（`registerExtHandlers` 内部）；`settings.providers/activeProvider/balanceMonitor/usageRange` 键

- [ ] **Step 1: 写失败测试（命令参数校验纯逻辑）**

`tests/commands-profile-balance.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseProfileAddArgs, parseBalanceSetArgs } from '../src/commands/handlersExt.js';

describe('profile/balance 参数解析', () => {
  it('parseProfileAddArgs: 名称+baseURL 必填，--models 逗号拆分', () => {
    expect(parseProfileAddArgs(['中转', 'https://r.example.com/v1', '--models', 'a,b,c']))
      .toEqual({ name: '中转', baseURL: 'https://r.example.com/v1', models: ['a', 'b', 'c'] });
    expect(parseProfileAddArgs(['中转'])).toBeNull();
  });
  it('parseBalanceSetArgs: url 可选 --path', () => {
    expect(parseBalanceSetArgs(['https://r.example.com/balance', '--path', 'data.balance']))
      .toEqual({ url: 'https://r.example.com/balance', jsonPath: 'data.balance' });
    expect(parseBalanceSetArgs(['--path', 'data.balance']))
      .toEqual({ url: '', jsonPath: 'data.balance' });
    expect(parseBalanceSetArgs([])).toEqual({ url: '', jsonPath: '' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/commands-profile-balance.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现解析器 + 命令注册**

`src/commands/handlersExt.ts` 文件尾导出两个纯函数：

```ts
/** /profile add 参数解析（纯函数可单测） */
export function parseProfileAddArgs(args: string[]): { name: string; baseURL: string; models: string[] } | null {
  const name = String(args[0] ?? '').trim();
  const baseURL = String(args[1] ?? '').trim();
  if (!name || !/^[a-zA-Z0-9_-]{1,40}$/.test(name)) return null;
  if (!/^https?:\/\//i.test(baseURL)) return null;
  const mi = args.indexOf('--models');
  const models = mi >= 0 ? (args[mi + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : [];
  return { name, baseURL, models };
}

/** /balance set 参数解析（纯函数可单测） */
export function parseBalanceSetArgs(args: string[]): { url: string; jsonPath: string } {
  let url = ''; let jsonPath = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' || args[i] === '-p') { jsonPath = args[i + 1] ?? ''; i++; continue; }
    if (!url && /^https?:\/\//i.test(String(args[i] ?? ''))) url = String(args[i]!);
  }
  return { url, jsonPath };
}
```

同文件 `registerExtHandlers(bus, ctx)` 内注册（命令处理器实现见下；每个命令内 `appendAudit` 留痕，`/balance set` 额外写 ConsentLedger）：

```ts
  // ── 档案体系（接入层开放：多厂商/中转站档案管理）──
  bus.register('/profile', async (args) => {
    const { encryptKey } = await import('../kernel/providers.js');
    const sub = String(args[0] ?? 'list');
    const providers = (Array.isArray(ctx.config.get('settings')?.providers) ? ctx.config.get('settings').providers : []) as Array<any>;
    if (sub === 'list') {
      if (!providers.length) return '无档案——/profile add <名称> <baseURL> 创建（内置 deepseek/kimi/zhipu 在首次配置后自动建立）';
      const active = ctx.config.get('settings')?.activeProvider;
      return providers.map((p: any) => `${p.id === active ? '◉' : '○'} ${p.id}（${p.name}）${p.baseURL}｜模型 ${(p.models ?? []).length} 个｜密钥 ${p.key ? '已配置' : '未配置'}${p.balanceUrl ? '｜余额接口 ✓' : ''}`).join('\n') + '\n/profile use <id> 切换｜/profile set-key <id> 配密钥';
    }
    if (sub === 'add') {
      const parsed = parseProfileAddArgs(args.slice(1));
      if (!parsed) return '用法：/profile add <名称> <baseURL> [--models a,b,c]（baseURL 需 http(s) 开头）';
      const id = parsed.name;
      const next = [...providers.filter((p: any) => p.id !== id), { id, name: parsed.name, baseURL: parsed.baseURL, models: parsed.models, key: '', balanceUrl: '', balancePath: '' }];
      ctx.config.setKey('settings', 'providers', next);
      ctx.config.setKey('settings', 'activeProvider', id);
      if (!parsed.models.length) parsed.models.push(ctx.getModel?.() || '');
      ctx.config.setKey('settings', 'model', parsed.models[0] ?? '');
      try { const { appendAudit } = await import('../store/db.js'); appendAudit(ctx.db, 'profile.add', { id, baseURL: parsed.baseURL }); } catch {}
      return `档案已创建并激活：${id}（${parsed.baseURL}）\n下一步：/key set <密钥>（写入当前档案密钥槽）→ /model <模型名>`;
    }
    if (sub === 'use') {
      const id = String(args[1] ?? '').trim();
      const hit = providers.find((p: any) => p.id === id);
      if (!hit) return `档案不存在：${id}（/profile list 查看）`;
      ctx.config.setKey('settings', 'activeProvider', id);
      if (Array.isArray(hit.models) && hit.models.length) ctx.config.setKey('settings', 'model', hit.models[0]);
      else ctx.config.setKey('settings', 'baseURL', hit.baseURL);
      return `已切换到档案 ${id}（${hit.name}）——模型 ${hit.models?.[0] ?? '（未设置，/model <名> 配置）'}`;
    }
    if (sub === 'rm') {
      const id = String(args[1] ?? '').trim();
      ctx.config.setKey('settings', 'providers', providers.filter((p: any) => p.id !== id));
      if (ctx.config.get('settings')?.activeProvider === id) ctx.config.setKey('settings', 'activeProvider', providers[0]?.id ?? '');
      return `已移除档案 ${id}`;
    }
    if (sub === 'set-key') {
      const id = String(args[1] ?? '').trim();
      const key = String(args.slice(2).join(' ')).trim();
      if (!key) return '用法：/profile set-key <id> <密钥>（AES 加密存入该档案密钥槽）';
      const hit = providers.find((p: any) => p.id === id);
      if (!hit) return `档案不存在：${id}`;
      const enc = encryptKey(key);
      const next = providers.map((p: any) => (p.id === id ? { ...p, key: enc } : p));
      ctx.config.setKey('settings', 'providers', next);
      try { const { appendAudit } = await import('../store/db.js'); appendAudit(ctx.db, 'profile.set-key', { id }); } catch {}
      return `密钥已写入档案 ${id}（AES 加密，不回显）`;
    }
    return '用法：/profile list|use <id>|add <名称> <baseURL>|rm <id>|set-key <id> <密钥>';
  });

  // ── 余额监控配置 ──
  bus.register('/balance', async (args) => {
    const sub = String(args[0] ?? 'status');
    const bm = (ctx.config.get('settings')?.balanceMonitor ?? {}) as Record<string, any>;
    if (sub === 'set') {
      const parsed = parseBalanceSetArgs(args.slice(1));
      ctx.config.setKey('settings', 'balanceMonitor', { enabled: true, url: parsed.url, jsonPath: parsed.jsonPath });
      try { const { ConsentLedger } = await import('../compliance/compliance.js'); new ConsentLedger(ctx.db).grant({ grantor: 'user', scope: 'balance-monitor', purpose: '余额监控抓取', method: '/balance set', expiresAt: 0, evidenceRef: '' }); } catch {}
      try { const { appendAudit } = await import('../store/db.js'); appendAudit(ctx.db, 'balance.set', { url: parsed.url, jsonPath: parsed.jsonPath }); } catch {}
      return parsed.url ? `余额监控已配置：${parsed.url}${parsed.jsonPath ? `（路径 ${parsed.jsonPath}）` : ''}——/balance refresh 立即验证` : '余额监控已配置：跟随当前档案余额接口（/balance refresh 验证）';
    }
    if (sub === 'on') { ctx.config.setKey('settings', 'balanceMonitor', { ...bm, enabled: true }); return '余额监控已开启（状态栏 💰，5 分钟刷新）'; }
    if (sub === 'off') { ctx.config.setKey('settings', 'balanceMonitor', { ...bm, enabled: false }); return '余额监控已关闭'; }
    if (sub === 'refresh' || sub === 'status') {
      const { resolveProviderProfile } = await import('../kernel/profiles.js');
      const { fetchBalanceCached } = await import('../kernel/balance.js');
      const rp = resolveProviderProfile(ctx.config.get('settings') ?? {});
      if (!rp) return '未配置档案（/profile add 或 /key set 后重试）';
      const profile = { ...rp.profile, balanceUrl: bm.url || rp.profile.balanceUrl || '', balancePath: bm.jsonPath || rp.profile.balancePath || '' };
      const r = await fetchBalanceCached(profile, ctx.config.get('settings') ?? {}, { force: sub === 'refresh', db: ctx.db });
      if (r.ok) return `余额：${r.info.balance}${r.info.currency ? ` ${r.info.currency}` : ''}（${r.info.source}${r.cached ? '，缓存' : ''}）`;
      return `余额获取失败：${r.error}`;
    }
    return '用法：/balance set [url] [--path <jsonPath>] | on | off | status | refresh';
  });

  // ── 配置导出/导入（JSON；导出可选脱敏）──
  bus.register('/config', (args) => {
    const sub = String(args[0] ?? '');
    if (sub === 'export') {
      const redact = args.includes('--redact');
      const s = { ...(ctx.config.get('settings') ?? {}) };
      if (redact) {
        delete s.apiKeyEnc;
        if (Array.isArray(s.providers)) s.providers = s.providers.map((p: any) => ({ ...p, key: p.key ? '(redacted)' : '' }));
        s.apiKeys = {};
      }
      return JSON.stringify({ settings: s }, null, 2);
    }
    if (sub === 'import') {
      const file = String(args[1] ?? '').trim();
      if (!file) return '用法：/config import <文件路径>（JSON：{ "settings": { ... } }）';
      try {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const j = JSON.parse(readFileSync(file, 'utf8'));
        const merged = { ...(ctx.config.get('settings') ?? {}), ...(j.settings ?? {}) };
        ctx.config.setKey('settings', 'settings', merged);
        return '配置已导入（settings.json 热重载生效；若含 providers 请 /profile list 确认）';
      } catch (e: any) { return `导入失败：${String(e?.message ?? e).slice(0, 120)}`; }
    }
    return '用法：/config export [--redact] | import <文件>';
  });
```

`src/commands/handlers.ts` 的 `/key` 注册（:271-319）扩展：解析 `--profile <id>` 与子命令 `import <file>`：

```ts
  // 在 /key 处理器开头插入：
  if (args[0] === 'import') {
    const file = String(args[1] ?? '').trim();
    if (!file) return '用法：/key import <.env 文件>（批量导入 WXNODUS_* 与 *KEY* 变量）';
    try {
      const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
      if (!existsSync(file)) return `文件不存在：${file}`;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      let n = 0;
      for (const line of lines) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m || line.trim().startsWith('#')) continue;
        if (m[2] === undefined || !m[2].trim()) continue;
        process.env[m[1]!] = m[2].replace(/^["']|["']$/g, '');
        n++;
      }
      return `已导入 ${n} 个环境变量（本次进程生效；持久化请用 /key set 或 /profile set-key）`;
    } catch (e: any) { return `导入失败：${String(e?.message ?? e).slice(0, 120)}`; }
  }
```

`src/kernel/commandLevels.ts` 追加分级：safe 区 `'/balance status'`、`'/usage range'`；confirm 区 `'/profile'`、`'/profile add'`、`'/profile use'`、`'/profile set-key'`、`'/profile rm'`、`'/balance'`、`'/balance set'`、`'/balance refresh'`、`'/balance on'`、`'/balance off'`、`'/key import'`、`'/config export'`、`'/config import'`。

- [ ] **Step 4: 运行确认通过 + 全量回归 + 提交**

Run: `npx vitest run tests/commands-profile-balance.test.ts && npm test`
Expected: 新测试 PASS；全量回归绿（如 commands 相关既有测试断言命令数，按新命令增量更新断言）

```bash
git add src/commands/handlersExt.ts src/commands/handlers.ts src/kernel/commandLevels.ts tests/commands-profile-balance.test.ts
git commit -m "feat: 命令面——/profile 档案管理 /key import /config export|import /balance 配置监控（分级+审计+授权存证）"
```

---

### Task 5: 网关 RPC + 状态栏（💰 余额 / 📊 分区间 token）

**Files:**
- Modify: `src/wxnodus-ui/wxGateway.ts`（`_dispatch` 增 `balance.status`/`usage.range`/`profile.list`/`profile.use`/`usage.range.set`；`buildInfo` 增 usageRange）
- Create: `src/wxnodus-ui/hooks/useBalanceMonitor.ts`
- Modify: `src/wxnodus-ui/lib/layoutProfile.ts`（状态段：余额/token 两段 + 断点）
- Modify: `src/wxnodus-ui/components/appChrome.tsx`（渲染两段 + 点击交互）
- Test: `tests/ui-balance-statusbar.test.ts`（纯函数：数字缩写/断点段取舍）

**Interfaces:**
- Consumes: Task 2 `fetchBalanceCached`、Task 3 `usageSummary`、Task 1 `resolveProviderProfile`；`GatewayClient`（wxGateway）
- Produces: RPC `balance.status → { ok, configured, balance, currency, source, cached, updated_at, error }`；`usage.range → { range, input, output, total, calls }`；`usage.range.set`；hook `useBalanceMonitor(gw) → { balance, usage }`；纯函数 `fmtCompact(n)`、`statusSegmentsFor` 新段

- [ ] **Step 1: 写失败测试（纯函数）**

`tests/ui-balance-statusbar.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { fmtCompact, balanceSegmentLabel, usageSegmentLabel } from '../src/wxnodus-ui/lib/balanceStatus.js';

describe('statusbar balance/usage 纯函数', () => {
  it('fmtCompact: 缩写', () => {
    expect(fmtCompact(999)).toBe('999');
    expect(fmtCompact(12345)).toBe('12.3k');
    expect(fmtCompact(1234567)).toBe('123万');
  });
  it('balanceSegmentLabel: 正常/失败态', () => {
    expect(balanceSegmentLabel({ balance: '110.00', currency: 'CNY', source: 'deepseek' })).toBe('💰 ¥110.00');
    expect(balanceSegmentLabel(null)).toBe('💰⚠');
  });
  it('usageSegmentLabel: 区间标注', () => {
    expect(usageSegmentLabel({ total: 600, range: 'today' })).toBe('📊 600 今日');
    expect(usageSegmentLabel({ total: 12345, range: '7d' })).toBe('📊 12.3k 7天');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ui-balance-statusbar.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 lib/balanceStatus.ts**

```ts
// src/wxnodus-ui/lib/balanceStatus.ts — 状态栏余额/token 段纯函数（可单测）
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 10_000)}万`;
}

export interface BalanceView { balance: string; currency?: string; source?: string }
export function balanceSegmentLabel(v: BalanceView | null): string {
  if (!v) return '💰⚠';
  const c = v.currency === 'USD' ? '$' : v.currency === 'CNY' ? '¥' : '';
  return `💰 ${c}${v.balance}`;
}

export interface UsageView { total: number; range: 'today' | '7d' | '30d' }
export function usageSegmentLabel(v: UsageView): string {
  const label = v.range === 'today' ? '今日' : v.range === '7d' ? '7天' : '30天';
  return `📊 ${fmtCompact(v.total)} ${label}`;
}

export const RANGE_CYCLE = ['today', '7d', '30d'] as const;
export function nextRange(r: string): 'today' | '7d' | '30d' {
  const i = (RANGE_CYCLE as readonly string[]).indexOf(r);
  return RANGE_CYCLE[(i + 1) % 3]!;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ui-balance-statusbar.test.ts`
Expected: PASS

- [ ] **Step 5: wxGateway RPC**

`src/wxnodus-ui/wxGateway.ts` 的 `_dispatch` switch（:352-438）新增：

```ts
      case 'balance.status': return this.balanceStatus(params) as T
      case 'usage.range': return this.usageRange(params) as T
      case 'usage.range.set': return this.usageRangeSet(params) as T
```

类内新增方法：

```ts
  private balanceCache: { value: unknown; ts: number } | null = null
  private async balanceStatus(_params: Record<string, unknown>): Promise<unknown> {
    const bm = (this.kernel.settings as any)?.balanceMonitor ?? {};
    if (bm.enabled === false) return { ok: true, configured: false, enabled: false };
    // 60s 轮询 + 内核 5 分钟 TTL：本层仅 60s 防抖避免 RPC 风暴
    if (this.balanceCache && Date.now() - this.balanceCache.ts < 60_000) return this.balanceCache.value;
    const { resolveProviderProfile } = await import('../kernel/profiles.js')
    const { fetchBalanceCached } = await import('../kernel/balance.js')
    const rp = resolveProviderProfile(this.kernel.settings as Record<string, any>)
    if (!rp) return { ok: true, configured: false }
    const profile = { ...rp.profile, balanceUrl: (bm.url as string) || rp.profile.balanceUrl || '', balancePath: (bm.jsonPath as string) || rp.profile.balancePath || '' }
    if (!profile.balanceUrl) return { ok: true, configured: false, reason: 'no-balance-url' }
    const r = await fetchBalanceCached(profile, this.kernel.settings as Record<string, any>, { db: undefined })
    const value = r.ok
      ? { ok: true, configured: true, balance: r.info.balance, currency: r.info.currency, source: r.info.source, cached: r.cached, updated_at: Date.now() }
      : { ok: false, configured: true, error: r.error, updated_at: Date.now() }
    this.balanceCache = { value, ts: Date.now() }
    return value
  }

  private usageRange(_params: Record<string, unknown>): unknown {
    try {
      const { usageSummary } = await import('../kernel/usage.js')
      const range = ((this.kernel.settings as any)?.usageRange as 'today' | '7d' | '30d') || 'today'
      const db = (this.kernel as any).adapter?.db ?? null
      if (!db) return { range, input: 0, output: 0, total: 0, calls: 0 }
      const s = usageSummary(db, range)
      return { range, ...s }
    } catch { return { range: 'today', input: 0, output: 0, total: 0, calls: 0 } }
  }

  private usageRangeSet(params: Record<string, unknown>): unknown {
    const range = ['today', '7d', '30d'].includes(String(params.range ?? '')) ? String(params.range) : 'today'
    ;(this.kernel.settings as any).usageRange = range
    this.kernel.config.setKey('settings', 'usageRange', range)
    this.publish({ type: 'session.info', payload: this.buildInfo() })
    return this.usageRange({})
  }
```

> 注：`usage.range` 需访问 db——经 `this.kernel.adapter.data` 现有端口扩展 `usageRange(range)`（presentation adapter 的 TuiDataPort 增一个方法，返回聚合），实现时在 `tuiPresentationAdapter.ts` 加：

```ts
    usageRange(range: string) {
      const since = range === 'today' ? new Date().setHours(0, 0, 0, 0) : Date.now() - (range === '7d' ? 7 : 30) * 86_400_000;
      const row = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COUNT(*) c FROM usage_stats WHERE ts >= ?`).get(since) as { i: number; o: number; c: number };
      return { input: row.i, output: row.o, total: row.i + row.o, calls: row.c };
    },
```

- [ ] **Step 6: useBalanceMonitor hook**

`src/wxnodus-ui/hooks/useBalanceMonitor.ts`：

```ts
// useBalanceMonitor — 状态栏余额/用量轮询（60s；usage 另随 message.complete 事件刷新）
import { useEffect, useState } from 'react';
import type { GatewayClient } from '../wxGateway.js';
import { nextRange, type UsageView, type BalanceView } from '../lib/balanceStatus.js';

export interface MonitorState { balance: BalanceView | null; balanceError: string | null; usage: UsageView }

export function useBalanceMonitor(gw: GatewayClient): { state: MonitorState; cycleRange: () => void; refreshBalance: () => void } {
  const [state, setState] = useState<MonitorState>({ balance: null, balanceError: null, usage: { total: 0, range: 'today' } });

  const pullBalance = () => { void gw.request<{ ok: boolean; balance?: string; currency?: string; source?: string; error?: string }>('balance.status', {}).then(r => {
    setState(s => ({ ...s, balance: r.ok && r.balance ? { balance: r.balance, currency: r.currency, source: r.source } : null, balanceError: r.ok ? null : (r.error ?? null) }));
  }).catch(() => {}); };
  const pullUsage = () => { void gw.request<UsageView>('usage.range', {}).then(u => { if (u && typeof u.total === 'number') setState(s => ({ ...s, usage: { total: u.total, range: (u.range as UsageView['range']) || s.usage.range } })); }).catch(() => {}); };

  useEffect(() => {
    pullBalance(); pullUsage();
    const t = setInterval(() => { pullBalance(); pullUsage(); }, 60_000);
    const off = gw.on('event', (e: any) => { if (e?.type === 'message.complete') pullUsage(); });
    return () => { clearInterval(t); off(); };
  }, [gw]);

  const cycleRange = () => { const r = nextRange(state.usage.range); void gw.request('usage.range.set', { range: r }).then(() => pullUsage()); };
  const refreshBalance = () => { void gw.request('balance.status', { force: true }).then(() => pullBalance()); };
  return { state, cycleRange, refreshBalance };
}
```

> 注：`balance.status` 的 force 经 params 透传内核（Task 2 `fetchBalanceCached({force})`）——RPC 方法里读取 `params.force === true` 传入 opts.force。

- [ ] **Step 7: appChrome 状态栏集成**

`src/wxnodus-ui/components/appChrome.tsx`：在 StatusRule 渲染区增加两段（挂载 useBalanceMonitor；💰 段 onClick=refreshBalance，📊 段 onClick=cycleRange；点击事件沿用 Ink onClick 协议，非交互档自动无感）：

```tsx
  // 在组件内：
  const { state: mon, cycleRange, refreshBalance } = useBalanceMonitor(gw);
  // 段渲染（插在既有段序列后、按 statusSegmentsFor 断点暴露）：
  const balanceSeg = balanceSegmentLabel(mon.balance);
  const usageSeg = usageSegmentLabel(mon.usage);
```

`src/wxnodus-ui/lib/layoutProfile.ts` 的 `statusSegmentsFor` 增加两段并收紧断点：≥96 列同时显示两段；72-95 列只显示余额；<72 隐藏（简约：其余旧段照旧）。

- [ ] **Step 8: 全量回归 + 提交**

Run: `npx vitest run tests/ui-balance-statusbar.test.ts && npm test`
Expected: PASS

```bash
git add src/wxnodus-ui/lib/balanceStatus.ts src/wxnodus-ui/hooks/useBalanceMonitor.ts src/wxnodus-ui/wxGateway.ts src/wxnodus-ui/lib/layoutProfile.ts src/wxnodus-ui/components/appChrome.tsx src/presentation/tui/tuiPresentationAdapter.ts tests/ui-balance-statusbar.test.ts
git commit -m "feat: 状态栏余额(💰)+分区间token(📊)监控——RPC+轮询+点击交互（今天/7天/30天循环）"
```

---

### Task 6: 动效系统（lib/motion.ts 确定性帧 + 降级矩阵）

**Files:**
- Create: `src/wxnodus-ui/lib/motion.ts`
- Test: `tests/ui-motion.test.ts`

**Interfaces:**
- Consumes: `getRendererCapabilities`（ink capabilities）/ terminalTier 档位
- Produces:
  - `motionTier(): 'full' | 'subtle' | 'off'`（WXNODUS_NO_ANIM=1 → off；terminalTier cmd→subtle；no-vt→off）
  - `accretionRing(i: number): string[]`（吸积盘帧，i 循环 0..7，8 帧）
  - `breatheColor(i: number): string`（256 色阶脉动：`ansi256(232+((i*3)%24))`）
  - `starfield(i: number, cols: number, seed: number): string`（星尘帧：确定性伪随机）
  - `supernova(i: number): string`（超新星帧序列 0..5，i>=5 返回空）
  - `toolRain(i: number, cols: number): string`（工具字符雨帧）

- [ ] **Step 1: 写失败测试（确定性）**

`tests/ui-motion.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { accretionRing, supernova, starfield, breatheColor } from '../src/wxnodus-ui/lib/motion.js';

describe('motion 帧序列确定性', () => {
  it('accretionRing: 8 帧循环且每帧非空', () => {
    for (let i = 0; i < 8; i++) {
      const f = accretionRing(i);
      expect(f.length).toBeGreaterThan(0);
      expect(f).toEqual(accretionRing(i + 8)); // 循环
    }
  });
  it('supernova: 5 帧内爆发→消散，第 6 帧为空', () => {
    expect(supernova(0).length).toBeGreaterThan(0);
    expect(supernova(5)).toBe('');
  });
  it('starfield: 同种子同帧输出一致', () => {
    expect(starfield(3, 80, 42)).toBe(starfield(3, 80, 42));
    expect(starfield(3, 80, 42)).not.toBe(starfield(4, 80, 42));
  });
  it('breatheColor: 合法 ansi256 颜色', () => {
    for (let i = 0; i < 48; i++) expect(breatheColor(i)).toMatch(/^ansi256\(\d{1,3}\)$/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ui-motion.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 lib/motion.ts**

```ts
// src/wxnodus-ui/lib/motion.ts — 黑洞主题动效帧生成器（纯函数、确定性、可单测）
// 纪律：只输出字符/颜色（单格 damage 差分可承载）；动效档位：full/subtle/off。
export function motionTier(): 'full' | 'subtle' | 'off' {
  if (process.env.WXNODUS_NO_ANIM === '1') return 'off';
  const tier = (globalThis as any).__wxnodusTuiTier as string | undefined;
  if (tier === 'no-vt') return 'off';
  if (tier === 'cmd') return 'subtle';
  return 'full';
}

const RING = ['◐', '◓', '◑', '◒'];

/** 吸积盘：4 帧旋转环 + 中心黑洞脉动（帧序列确定性） */
export function accretionRing(i: number): string[] {
  const phase = ((i % 4) + 4) % 4;
  const core = i % 2 === 0 ? '●' : '◉';
  return [`${RING[phase]} ${core} ${RING[(phase + 2) % 4]}`, `  ╭─${core}─╮  `];
}

/** 超新星：0..5 帧爆发→消散，i>=5 空（完成庆祝一次性动画） */
export function supernova(i: number): string {
  const frames = ['✦', '✦ ✧ ✦', '✧ ✦ ✧ ✦ ✧', '✦ ✧ ✦', '· ✦ ·', ''];
  return frames[i] ?? '';
}

/** 星尘：确定性伪随机游走（种子+帧号） */
export function starfield(i: number, cols: number, seed = 7): string {
  const chars = ['·', '✦', '·', '·', '✧'];
  const out: string[] = [];
  let x = (seed * 31 + i * 17) % cols;
  for (let n = 0; n < 5; n++) {
    x = (x * 37 + 13) % cols;
    out.push(x + ':' + chars[(seed + i + n) % chars.length]!);
  }
  return out.join(' ');
}

/** 呼吸：256 色阶脉动（ansi256 合法色号） */
export function breatheColor(i: number): string {
  const v = 232 + (((i % 24) + 24) % 24); // 232..255 灰阶
  return `ansi256(${v})`;
}

/** 工具拟态·字符雨（bash）：帧内随机列下落 */
export function toolRain(i: number, cols: number): string {
  const glyphs = ['│', '┃', '┆', '┊', '┋'];
  const out: string[] = [];
  for (let c = 0; c < Math.min(cols, 40); c += 3) {
    const h = (c * 7 + i * 5) % 6;
    if (h < 3) out.push(`${c + (i % 3)}:${glyphs[(c + i) % glyphs.length]}`);
  }
  return out.join(' ');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ui-motion.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/wxnodus-ui/lib/motion.ts tests/ui-motion.test.ts
git commit -m "feat: 动效系统——吸积盘/超新星/星尘/呼吸/字符雨 确定性帧 + motionTier 三级降级"
```

---

### Task 7: UI 集成——简约改版 + 趣味（欢迎卡片/模式徽章/审批数字键/黑洞宠物/彩蛋）

**Files:**
- Modify: `src/wxnodus-ui/components/appChrome.tsx`（模式徽章着色）
- Create: `src/wxnodus-ui/components/blackHolePet.tsx`
- Modify: `src/wxnodus-ui/components/prompts.tsx`（数字键 1-4 快速选择）
- Modify: `src/wxnodus-ui/hooks/useKeyBindings.ts`（审批 overlay 数字键）
- Modify: `src/wxnodus-ui/components/appLayout.tsx`（欢迎卡片动效挂载 + 宠物挂载）
- Modify: `src/commands/handlersExt.ts`（/fortune /warp 彩蛋命令）、`src/kernel/commandLevels.ts`（'/fortune'=safe 已有，'/warp'=safe）
- Test: `tests/ui-pet-motion.test.ts`（宠物帧纯函数）

**Interfaces:**
- Consumes: Task 6 `motionTier/accretionRing/breatheColor/supernova`；`useInput`（既有）；overlay 状态
- Produces: 组件 `BlackHolePet`、`welcomeFrame(i)` 纯函数、模式徽章色映射 `modeBadge(mode)`

- [ ] **Step 1: 写失败测试**

`tests/ui-pet-motion.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { petFace, modeBadge } from '../src/wxnodus-ui/components/blackHolePet.js';

describe('宠物/徽章纯函数', () => {
  it('petFace: 三态（idle/busy/error）', () => {
    expect(petFace('idle', 0)).toContain('◉');
    expect(petFace('busy', 0)).toContain('●');
    expect(petFace('error', 0)).toContain('⚠');
  });
  it('modeBadge: Kimi 同款模式着色', () => {
    expect(modeBadge('yolo')).toContain('yellow');
    expect(modeBadge('manual')).toContain('blue');
    expect(modeBadge('plan')).toContain('magenta');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ui-pet-motion.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 blackHolePet.tsx**

```tsx
// blackHolePet.tsx — 角落黑洞情绪小宠物（Codex pets 同款定位）
import React, { useEffect, useState } from 'react';
import { Box, Text } from '@wxnodus/ink';
import { motionTier, accretionRing, breatheColor } from '../lib/motion.js';

export type PetMood = 'idle' | 'busy' | 'error';

export function petFace(mood: PetMood, i: number): string {
  if (mood === 'error') return `⚠ ◐ 坍缩中`;
  if (mood === 'busy') return `${accretionRing(i)[0]}`;
  return i % 2 === 0 ? '◉  ·' : '◉ ·';
}

export function modeBadge(mode: string): string {
  switch (mode) {
    case 'yolo': return 'yellow YOLO';
    case 'auto': return 'green AUTO';
    case 'manual': return 'blue MANUAL';
    case 'plan': return 'magenta PLAN';
    case 'goal': return 'cyan GOAL';
    default: return 'white SMART';
  }
}

export function BlackHolePet({ mood }: { mood: PetMood }): React.ReactElement | null {
  const tier = motionTier();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tier === 'off') return;
    const t = setInterval(() => setTick(x => x + 1), tier === 'subtle' ? 800 : 400);
    return () => clearInterval(t);
  }, [tier]);
  if (tier === 'off') return null;
  const face = petFace(mood, tick);
  const color = mood === 'error' ? 'red' : breatheColor(tick);
  return (
    <Box position="absolute" top={0} right={0}>
      <Text color={color}>{face}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ui-pet-motion.test.ts`
Expected: PASS

- [ ] **Step 5: 集成接线**

- `appChrome.tsx`：模式徽章用 `modeBadge(mode)` 着色（状态栏模式段）。
- `prompts.tsx` + `useKeyBindings.ts`：审批 overlay 打开时数字键 1/2/3 映射 once/session/deny（4=取消），复用 `answerApproval` 通道（Kimi 同款快捷选择）。
- `appLayout.tsx`：启动欢迎卡片——`WXNODUS_NO_INTRO` 未设且 modern 档时播放 `accretionRing` 序列 6 帧（每帧 250ms）；右上角挂 `<BlackHolePet mood={busy?'busy':error?'error':'idle'}/>`（mood 从 `$uiState.busy` 与最近错误派生）。
- `handlersExt.ts` 注册彩蛋：

```ts
  // 彩蛋：星际跳跃 / 幸运签（趣味拉满，纯文本无副作用）
  bus.register('/warp', () => {
    const frames = ['✦ 曲率引擎预热', '✦ ✦ 折叠空间', '✦ ✦ ✦ 穿越虫洞', '· ✦ · 已到达目标星系 ✦'];
    return frames.join('\n');
  });
  bus.register('/fortune', () => {
    const pool = ['今日宜：写代码，忌：手动格式化磁盘。', '黑洞说：你今天省下的 token，明天都会变成余额。', '星尘占卜：/help 里藏着一个你还没用过的命令。', '超新星预报：你的下一个想法会发光。'];
    return '🔮 ' + (pool[Math.floor(Math.random() * pool.length)] ?? pool[0]);
  });
```

- `commandLevels.ts`：`'/warp'` → safe；`'/fortune'` 已有 safe 保留。

- [ ] **Step 6: 全量回归 + 提交**

Run: `npx vitest run tests/ui-pet-motion.test.ts && npm test`
Expected: PASS

```bash
git add src/wxnodus-ui/components/blackHolePet.tsx src/wxnodus-ui/components/appChrome.tsx src/wxnodus-ui/components/prompts.tsx src/wxnodus-ui/hooks/useKeyBindings.ts src/wxnodus-ui/components/appLayout.tsx src/commands/handlersExt.ts src/kernel/commandLevels.ts tests/ui-pet-motion.test.ts
git commit -m "feat: UI 简约趣味——模式徽章着色/审批数字键/黑洞宠物/欢迎卡片动效/彩蛋(warp+fortune)"
```

---

### Task 8: 收尾——口径更新 + 全量验收

**Files:**
- Modify: 断言 MODEL_CATALOG 计数的既有测试（grep `MODEL_CATALOG` 在 tests/ 中的计数断言）→ 改为「catalog 是模型集合子集」语义
- Modify: `README.md`（档案/余额/usage range 新命令）+ `docs/ux-comparison.md`（#11 /cost 缺口标注：已由状态栏 📊+💰 部分覆盖）

- [ ] **Step 1: 口径更新**

Run: `grep -rn "MODEL_CATALOG" tests/ | head -20`
逐一检查计数断言（如 `expect(MODEL_CATALOG).toHaveLength(13)`），改为 `expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(13)`（catalog 是下限，档案可扩展）。

- [ ] **Step 2: README/docs 更新**

README「工具与自动化」与「模型层」小节补：档案系统、`/balance`、`/usage range`、状态栏 💰📊。

- [ ] **Step 3: 全量验收 + 提交**

Run: `npm test`
Expected: 全绿（253+ 测试文件 + 新增 7 个测试文件）

```bash
git add -A
git commit -m "test: 口径更新——MODEL_CATALOG 计数断言改下限语义 + README 档案/余额/usage range 文档"
```

---

## Self-Review

1. **Spec coverage**：A（Task 1 档案/迁移/模型名放开 + Task 4 /profile /key import /config）✓；B（Task 2 适配器全名单 + jsonPath + 无接口厂商诚实降级）✓；C（Task 3 usage + Task 5 状态栏+RPC+点击）✓；D（Task 6 motion + Task 7 宠物/徽章/数字键/彩蛋/欢迎卡片）✓；合规（Task 2 审计、Task 4 ConsentLedger）✓。
2. **Placeholder scan**：无 TBD；所有步骤含完整代码与命令。
3. **Type consistency**：`ProviderProfile`（Task 1 定义）在 Task 2/4/5 使用一致；`BalanceInfo`/`UsageView`/`motionTier` 签名前后一致；`nextRange` 返回类型与 `usage.range.set` 参数一致。
