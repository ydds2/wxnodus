// src/kernel/balance.ts — 余额查询适配器链（一家一纯函数 + 注册表）
// 取证（2026-08-17）：deepseek=官方文档确认（api-docs.deepseek.com /user/balance）；
// kimi/siliconflow/openrouter=形状已知 (R)；智谱/OpenAI/Anthropic 无密钥可查余额接口——
// 档案 balanceUrl 留空时诚实不显示（绝不伪造）。
// 合规：抓取成败 appendAudit 留痕（不含密钥）；/balance set 由命令层写 ConsentLedger。
import { getByPath } from './jsonPath.js';
import { safeFetchText } from './ssrf.js';
import { resolveApiKey, mapHttpError } from './providers.js';
import { appendAudit } from '../store/db.js';
import type { ProviderProfile } from './profiles.js';

export interface BalanceInfo { balance: string; currency?: string; source: string }

const numStr = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v)) ? String(v) : (typeof v === 'string' && v.trim() !== '') ? v.trim() : null;

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

/** generic 启发式：键名含 balance/余额/available/cash/credit 的数值（深度 2 内） */
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

/** host 判定 + 适配器链 + jsonPath 兜底（未命中=null，诚实不伪造） */
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

/** 按档案余额 URL 抓取（Bearer 认证；非 2xx/非 JSON 诚实归因） */
export async function fetchBalance(profile: ProviderProfile, settings: Record<string, any>): Promise<{ ok: true; info: BalanceInfo } | { ok: false; error: string; status?: number }> {
  const url = String(profile.balanceUrl ?? '').trim();
  if (!url) return { ok: false, error: '该档案未配置余额接口（/balance set <url> 配置；智谱/OpenAI/Anthropic 无密钥可查接口）' };
  let host = 'unknown';
  try { host = new URL(url).host; } catch { return { ok: false, error: `余额 URL 无效：${url.slice(0, 80)}` }; }
  const keyRes = resolveApiKey({ ...settings, baseURL: profile.baseURL });
  if (!keyRes.key) return { ok: false, error: '当前档案未配置密钥（/model set-key <密钥> 配置后重试）' };
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

/** TTL 5 分钟缓存（force=true 强制刷新；db 提供时审计留痕） */
export async function fetchBalanceCached(profile: ProviderProfile, settings: Record<string, any>, opts: { force?: boolean; db?: any } = {}): Promise<{ ok: true; info: BalanceInfo; cached: boolean } | { ok: false; error: string; status?: number }> {
  const key = `${profile.id}:${profile.balanceUrl}`;
  if (!opts.force && cache && cache.key === key && Date.now() - cache.ts < TTL_MS) return { ok: true, info: cache.info, cached: true };
  const r = await fetchBalance(profile, settings);
  if (r.ok) {
    cache = { key, info: r.info, ts: Date.now() };
    try { if (opts.db) appendAudit(opts.db, 'balance.fetch', { ok: true, source: r.info.source, profile: profile.id }); } catch { /* 审计失败静默 */ }
  } else {
    try { if (opts.db) appendAudit(opts.db, 'balance.fetch', { ok: false, error: r.error.slice(0, 120), profile: profile.id }); } catch { /* 静默 */ }
  }
  return r.ok ? { ok: true, info: r.info, cached: false } : r;
}

// ── 低余额预警（余额耗尽场景的护栏：纯函数可单测）──
/** 余额字符串 → 数值（宽容解析：¥110.00 / $12.34 / 1,234.5 / 123万? 不支持——仅数字形态） */
export function numericBalance(info: { balance: string } | null | undefined): number | null {
  const raw = String(info?.balance ?? '').replace(/[,，\s]/g, '');
  const m = /-?\d+(\.\d+)?/.exec(raw);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 低余额通知状态机：低于阈值且未通知过 → notify；回升到阈值以上 → 重新武装（下次再低会再提醒） */
export function lowBalanceDecision(value: number | null, threshold: number, lastNotified: boolean): { notify: boolean; armed: boolean } {
  if (value === null) return { notify: false, armed: lastNotified };
  if (value < threshold) return lastNotified ? { notify: false, armed: true } : { notify: true, armed: true };
  return { notify: false, armed: false };
}

/** 低余额默认阈值（可经 balanceMonitor.lowThreshold 覆盖） */
export const LOW_BALANCE_THRESHOLD = 5;

/** 余额耗尽自动停判定：仅当用户显式开启 autoStop 且余额 ≤ 0 时停（纯函数可单测） */
export function balanceStopDecision(value: number | null, autoStop: boolean): boolean {
  return autoStop === true && value !== null && value <= 0;
}
