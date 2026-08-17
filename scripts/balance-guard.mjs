#!/usr/bin/env node
// scripts/balance-guard.mjs — DeepSeek 余额监控（/goal 预算护栏：余额不足 1 元自动打断收敛）
// 用法：node scripts/balance-guard.mjs [--data-dir <dir>] [--min <元>]
// 行为：读 wxnodus settings（apiKeys.deepseek 槽位 → AES 解密仅在内存）→ GET https://api.deepseek.com/user/balance
//       → 打印余额（绝不回显密钥）；退出码：0=余额≥min / 1=余额<min（应打断）/ 2=无 deepseek 密钥或请求失败
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = flag('--data-dir') ?? process.env.WXNODUS_DATA_DIR ?? join(ROOT, 'data');
const min = Number(flag('--min') ?? 1);

const { decryptKey } = await import(join(ROOT, 'dist', 'kernel', 'providers.js')).catch(() => ({}));
const settingsPath = join(dataDir, 'settings.json');
let settings = {};
try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* 无配置 */ }

function deepseekKey() {
  // 1) 环境变量（用户机器自配，零落盘回显）
  const envCands = [process.env.WXNODUS_DEEPSEEK_KEY, process.env.DEEPSEEK_API_KEY, process.env.WXNODUS_API_KEY];
  for (const e of envCands) if (e && e.trim()) return e.trim();
  // 2) wxnodus settings（apiKeys 槽 / keyProvider / providers 中 deepseek 端点档案）
  const apiKeys = settings.apiKeys ?? {};
  const candidates = [
    apiKeys['deepseek'],
    apiKeys['deepseek-chat'],
    settings.keyProvider === 'deepseek' ? settings.apiKeyEnc : null,
    ...((settings.providers ?? []).filter(p => String(p?.baseURL ?? '').includes('deepseek')).map(p => p?.key)),
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c.startsWith('enc1:')) { const d = decryptKey?.(c); if (d) return d; }
    else return c;
  }
  return null;
}

const key = deepseekKey();
if (!key) {
  console.log('DEEPSEEK_KEY_MISSING: wxnodus settings 中无 DeepSeek 密钥（/model set-key 配置后可自动监控）');
  process.exit(2);
}
try {
  const resp = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) { console.log(`BALANCE_HTTP_${resp.status}`); process.exit(2); }
  const j = await resp.json();
  const info = j?.balance_infos?.find(b => b.currency === 'CNY') ?? j?.balance_infos?.[0];
  const total = Number(info?.total_balance ?? '0');
  console.log(`DEEPSEEK 余额：¥${total.toFixed(2)}（可用=${String(info?.is_available ?? '?')}）`);
  process.exit(total < min ? 1 : 0);
} catch (e) {
  console.log(`BALANCE_FETCH_FAILED: ${String(e?.message ?? e).slice(0, 120)}`);
  process.exit(2);
}
