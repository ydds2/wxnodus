// src/kernel/env.ts — 子进程环境净化（P0-3，Codex shell_environment_policy 思路自研）
// 设计：只传 core 环境 + 白名单，剥离含 KEY/SECRET/TOKEN/PASSWORD 的变量——
//       防密钥经子进程环境泄露。bash 工具 / hooks / MCP stdio 统一受益。
export const CORE_ENV = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR',
  'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'PWD', 'OLDPWD',
  'SHELL', 'USER', 'LOGNAME', 'NODE_ENV', 'WXNODUS_', 'MSYS', 'TERM_PROGRAM',
]);
const SECRET_ENV_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|AUTH|SIGNATURE|PRIVATE_?KEY)/i;

/** 生成净化后的子进程环境（白名单 core + 显式 extra；密钥类变量一律不传——
 *  含 WXNODUS_ 前缀内的密钥（WXNODUS_API_KEY / WXNODUS_<厂商>_KEY 等）——
 *  密钥只在该进程内被 resolveApiKey 读取，绝不透传 bash/hooks/MCP 子进程） */
export function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('WXNODUS_')) {
      // WXNODUS_ 命名空间内再按密钥模式过滤（防 WXNODUS_API_KEY 经子进程泄露）
      if (SECRET_ENV_RE.test(k)) continue;
      out[k] = v;
      continue;
    }
    if (CORE_ENV.has(k)) { out[k] = v; continue; }
    if (SECRET_ENV_RE.test(k)) continue; // 密钥类变量不传子进程
    if (k.startsWith('npm_') || k.startsWith('NODE_')) continue; // 噪声剔除
  }
  return { ...out, ...extra };
}

// ── V4 裁撤轨 D（2026-08-21 用户裁决：离线能力在 CLI 中无优势）──
// 软着陆纪律（Buddy 事件教训：功能下线无缓冲引发反弹）：本版默认禁用+deprecation 警告
// +WXNODUS_LEGACY_OFFLINE=1 逃生开关；下一版本物理删除代码与开关。
// 裁撤面：离线对话（offlineModel）/离线看图（moondream2+OCR 兜底）/无 key 确定性层。
// 保留面：语音、气隙升级、本地记忆向量、「数据不出机」定位（数据本地存储≠离线运行）。
export function legacyOfflineEnabled(): boolean {
  return process.env.WXNODUS_LEGACY_OFFLINE === '1';
}
export const OFFLINE_DEPRECATION_HINT =
  '离线能力已于 V4.0 裁撤（2026-08-21 决策：离线在 CLI 中无优势）——'
  + '临时续用请设置环境变量 WXNODUS_LEGACY_OFFLINE=1（下版移除）；'
  + '长期方案：/model set-key 配置云端模型（会话与数据仍全部本地存储）。';
