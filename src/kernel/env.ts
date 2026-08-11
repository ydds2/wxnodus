// src/kernel/env.ts — 子进程环境净化（P0-3，Codex shell_environment_policy 思路自研）
// 设计：只传 core 环境 + 白名单，剥离含 KEY/SECRET/TOKEN/PASSWORD 的变量——
//       防密钥经子进程环境泄露。bash 工具 / hooks / MCP stdio 统一受益。
export const CORE_ENV = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR',
  'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'PWD', 'OLDPWD',
  'SHELL', 'USER', 'LOGNAME', 'NODE_ENV', 'WXNODUS_', 'MSYS', 'TERM_PROGRAM',
]);
const SECRET_ENV_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|AUTH|SIGNATURE|PRIVATE_?KEY)/i;

/** 生成净化后的子进程环境（白名单 core + 显式 extra；密钥类变量一律不传） */
export function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (CORE_ENV.has(k) || k.startsWith('WXNODUS_')) { out[k] = v; continue; }
    if (SECRET_ENV_RE.test(k)) continue; // 密钥类变量不传子进程
    if (k.startsWith('npm_') || k.startsWith('NODE_')) continue; // 噪声剔除
  }
  return { ...out, ...extra };
}
