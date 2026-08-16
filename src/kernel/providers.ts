// src/kernel/providers.ts — L2-1 模型提供商层
// 设计：OpenAI 兼容 chat API（流式 SSE）+ AES-256-GCM 密钥加密（凭证安全红线，明文绝不落盘/回显）
//      + 规则脑兜底（无 key 诚实回答）+ 关键词路由降级链 + HTTP 错误中文映射
// 参考：OpenAI API 规范、Claude Code 的 credential 安全实践、Gemini CLI 多 provider 模式
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { hostname, platform, arch, userInfo } from 'node:os';

// ── 密钥加密（AES-256-GCM，机器指纹派生 key）─────────────────
// 格式：enc1:<iv hex>:<tag hex>:<cipher hex>——密钥来自机器指纹（不可移植，防拷贝泄露）
function machineFingerprint(): string {
  return hostname() + '::' + platform() + '::' + arch() + '::' + userInfo().username;
}

const encKey = (): Buffer => scryptSync(machineFingerprint(), 'wxnodus-v3', 32);

export function encryptKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptKey(stored: string): string | null {
  try {
    const [tag, ivHex, authHex, dataHex] = stored.split(':');
    if (tag !== 'enc1') return null;
    const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null; // 篡改/密钥不匹配：返回 null 不抛
  }
}

// ── 多 provider 适配（OpenAI 兼容生态的思考模式差异）────
// 各运营商的思考模式字段名与回传要求不同（deepseek 必须回传，否则 400）：
//   - DeepSeek：reasoning_content（必须原样回传）
//   - Moonshot/Kimi：reasoning_content（thinking 模型同字段）
//   - 智谱 GLM：reasoning_content（glm-4.5 thinking 输出）
//   - 未来 OpenAI 兼容厂商可能用 thinking_content 等别名
// 防御性策略：SSE 解析按别名表识别「首个命中的字段」，回传时用同名字段（原字段名回传）。
export const REASONING_FIELDS = ['reasoning_content', 'thinking_content', 'reasoning'] as const;

// 从 baseURL 推断 provider（未知 → 'openai-compatible'，仍走通用通道）
export function detectProvider(baseURL: string | undefined): string {
  const b = (baseURL ?? '').toLowerCase();
  if (b.includes('deepseek')) return 'deepseek';
  if (b.includes('moonshot')) return 'kimi';
  if (b.includes('bigmodel') || b.includes('zhipu')) return 'zhipu';
  return 'openai-compatible';
}

// ── 密钥解析（开放兼容：per-provider env 优先，UI 已展示的 WXNODUS_<厂商>_KEY 真实生效）──
// 读取顺序（文档化）：
//   1. WXNODUS_<PROVIDER>_KEY（provider 由 baseURL 推断大写：WXNODUS_DEEPSEEK_KEY 等，
//      已知厂商才生成该名，openai-compatible 跳过）
//   2. WXNODUS_API_KEY（通用 env）
//   3. settings.apiKeyEnc 解密（AES-256-GCM 加密槽位）
// env 密钥为用户亲手设置（非注入通道）；decrypt 失败返回 error 标记供调用方明确提示
const KNOWN_PROVIDER_KEYS = new Set(['deepseek', 'kimi', 'zhipu']);

export interface ApiKeyResolution {
  key: string | null;
  source: 'env' | 'enc' | 'none';
  /** 命中的 provider（detectProvider(baseURL)） */
  provider?: string;
  /** enc 解密失败（机器指纹变化等）或密钥归属与当前模型 provider 不符 */
  error?: 'decrypt-failed' | 'provider-mismatch';
  /** 面向用户的修复提示（调用方在无 key 提示中透出） */
  hint?: string;
}

// per-provider 密钥槽（settings.apiKeys.<provider>=enc 串）——多 provider 目录（deepseek/kimi/zhipu/offline）
// 与单一 apiKeyEnc 槽错配曾导致「智谱密钥发往 deepseek 端点 → 401」。apiKeys 按当前模型 provider 归属写入；
// 遗留 apiKeyEnc + keyProvider 归属标注向后兼容，归属不符时 fail-closed 不误发。
export function resolveApiKey(
  settings: { apiKeyEnc?: string | null; baseURL?: string; apiKeys?: Record<string, string> | null; keyProvider?: string | null },
  env: NodeJS.ProcessEnv = process.env
): ApiKeyResolution {
  const provider = detectProvider(settings.baseURL);
  // 档案密钥槽优先（profiles 体系）：按 activeProvider 档案的 key 槽归属
  const profile = ((settings as any)?.providers ?? []).find((p: any) => p?.id === (settings as any)?.activeProvider);
  if (profile?.key) {
    const dec = decryptKey(profile.key);
    if (dec) return { key: dec, source: 'enc', provider };
    return { key: null, source: 'enc', provider, error: 'decrypt-failed', hint: `档案 ${profile.id} 密钥槽解密失败（机器环境变化？）——/key set <密钥> 重新配置` };
  }
  const profileEnvKey = profile?.id ? env[`WXNODUS_${String(profile.id).toUpperCase()}_KEY`] : undefined;
  if (profileEnvKey?.trim()) return { key: profileEnvKey.trim(), source: 'env', provider };
  const providerKey = KNOWN_PROVIDER_KEYS.has(provider) ? env[`WXNODUS_${provider.toUpperCase()}_KEY`] : undefined;
  const genericKey = env.WXNODUS_API_KEY;
  const fromEnv = (providerKey ?? genericKey)?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env', provider };
  // per-provider 槽位优先（/key set 按当前模型 provider 归属写入）
  if (settings.apiKeys?.[provider]) {
    const dec = decryptKey(settings.apiKeys[provider]);
    if (dec) return { key: dec, source: 'enc', provider };
    return { key: null, source: 'enc', provider, error: 'decrypt-failed', hint: `${provider} 密钥槽位解密失败（机器环境变化？）——/key set <密钥> 重新配置` };
  }
  // 遗留单槽：归属校验——密钥属于别的 provider 时不误发（此前直接 401 且无提示）
  if (settings.apiKeyEnc) {
    if (settings.keyProvider && settings.keyProvider !== provider) {
      return {
        key: null, source: 'enc', provider, error: 'provider-mismatch',
        hint: `密钥槽位配置的是 ${settings.keyProvider} 密钥，当前模型 provider 是 ${provider}——/key set <密钥> 重配，或 /model 切换到 ${settings.keyProvider} 系模型`,
      };
    }
    const dec = decryptKey(settings.apiKeyEnc);
    if (dec) return { key: dec, source: 'enc', provider };
    return { key: null, source: 'enc', provider, error: 'decrypt-failed' };
  }
  return { key: null, source: 'none', provider };
}

// ── 模型目录（/model 选择器与直接切换共用）────────────────
export interface ModelCapabilities {
  imageIn?: boolean;   // 支持图片输入（视觉）
  thinking?: boolean;  // 支持推理链（reasoning）
  maxContext?: number; // 上下文窗口（token）
}

export interface ModelEntry {
  name: string;      // 显示名（如 DeepSeek V4 Flash）
  provider: string;  // 提供商（deepseek / kimi / zhipu）
  modelId: string;   // API model 字段
  baseURL: string;   // OpenAI 兼容端点
  capabilities?: ModelCapabilities; // 能力元数据（工具准入/UI 徽标）
}

export const MODEL_CATALOG: ModelEntry[] = [
  { name: 'DeepSeek Reasoner', provider: 'deepseek', modelId: 'deepseek-reasoner', baseURL: 'https://api.deepseek.com/v1', capabilities: { thinking: true, maxContext: 64_000 } },
  { name: 'DeepSeek Chat', provider: 'deepseek', modelId: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1', capabilities: { maxContext: 64_000 } },
  { name: 'DeepSeek V4 Flash', provider: 'deepseek', modelId: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com/v1', capabilities: { maxContext: 64_000 } },
  { name: 'DeepSeek V4 Pro', provider: 'deepseek', modelId: 'deepseek-v4-pro', baseURL: 'https://api.deepseek.com/v1', capabilities: { maxContext: 128_000 } },
  { name: 'K2.7 Coding', provider: 'kimi', modelId: 'kimi-k2.7', baseURL: 'https://api.moonshot.cn/v1', capabilities: { maxContext: 128_000 } },
  { name: 'K2.7 Coding Highspeed', provider: 'kimi', modelId: 'kimi-k2.7-highspeed', baseURL: 'https://api.moonshot.cn/v1', capabilities: { maxContext: 128_000 } },
  { name: 'K3', provider: 'kimi', modelId: 'kimi-k3', baseURL: 'https://api.moonshot.cn/v1', capabilities: { maxContext: 128_000 } },
  { name: 'K3-256k', provider: 'kimi', modelId: 'kimi-k3-256k', baseURL: 'https://api.moonshot.cn/v1', capabilities: { maxContext: 256_000 } },
  { name: 'GLM-4.5', provider: 'zhipu', modelId: 'glm-4.5', baseURL: 'https://open.bigmodel.cn/api/paas/v4', capabilities: { thinking: true, maxContext: 128_000 } },
  { name: 'GLM-4 Flash', provider: 'zhipu', modelId: 'glm-4-flash', baseURL: 'https://open.bigmodel.cn/api/paas/v4', capabilities: { maxContext: 128_000 } },
  { name: 'GLM-4V Flash', provider: 'zhipu', modelId: 'glm-4v-flash', baseURL: 'https://open.bigmodel.cn/api/paas/v4', capabilities: { imageIn: true, maxContext: 32_000 } },
  // ── 离线 token 包：本地 LLM（transformers.js + onnxruntime-node，零新增依赖）──
  // 选择后 llmStream/llmOnce 自动走本地通道；模型经 /offline pack download 预下载，
  // 下载后完全断网可用。边界：无工具调用（agent 离线为纯文本对话）、质量/速度有限
  { name: '离线 Qwen2.5-1.5B（本地）', provider: 'offline', modelId: 'offline:Qwen2.5-1.5B', baseURL: 'local://transformers', capabilities: { maxContext: 32_000 } },
  { name: '离线 Qwen2.5-3B（本地）', provider: 'offline', modelId: 'offline:Qwen2.5-3B', baseURL: 'local://transformers', capabilities: { maxContext: 32_000 } },
];

// 能力徽标（/model 列表与 UI 显示）
// 模型是否支持图像输入（imageIn 能力）——网关在注入图片前校验，文本模型优雅降级
export function hasImageIn(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const m = MODEL_CATALOG.find(x => x.modelId === modelId);
  return m?.capabilities?.imageIn === true;
}

export function capabilityBadges(c: ModelCapabilities | undefined): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.thinking) parts.push('🧠');
  if (c.imageIn) parts.push('👁');
  if (c.maxContext) parts.push(`${Math.round(c.maxContext / 1000)}k`);
  return parts.join(' ');
}

// 模糊过滤模型（名称/提供商/ID 子串，不区分大小写）
export function filterModels(q: string, catalog: ModelEntry[] = MODEL_CATALOG): ModelEntry[] {
  if (!q) return catalog;
  const s = q.toLowerCase().trim();
  return catalog.filter(m =>
    m.name.toLowerCase().includes(s) || m.provider.toLowerCase().includes(s) || m.modelId.toLowerCase().includes(s),
  );
}

// ── 规则脑（无 key 兜底：确定性诚实回答，绝不假装智能）─────────
// 能力边界：打招呼 / 简单计算 / 说明状态；其余诚实告知未配置
export function ruleBrain(input: string): string {
  const s = input.trim();
  if (!s) return '（空输入）';
  if (/^(你好|hi|hello|在吗|嗨)/i.test(s)) {
    return '你好！我是 WxNodus（本地概念编译器）。当前未配置模型密钥——输入「/key <你的密钥>」配置后即可获得完整能力；未配置时我只能做确定性的简单回答。';
  }
  // 简单四则运算（从中文句中提取表达式，仅数字与 +-*() 空格，防注入）
  const exprMatch = s.match(/[\d\s+\-*/().]{2,}/);
  if (exprMatch && /[+\-*/]/.test(exprMatch[0])) {
    const expr = exprMatch[0].trim();
    if (/^[\d\s+\-*/().]+$/.test(expr)) {
      try {
        const v = Function(`"use strict"; return (${expr});`)();
        if (typeof v === 'number' && Number.isFinite(v)) return `= ${v}`;
      } catch { /* 落入下方兜底 */ }
    }
  }
  return '未配置模型密钥，超出规则脑能力。配置方式：/key <密钥> 或 /key set <密钥>。';
}

// ── 请求构造（OpenAI 兼容 /chat/completions）────────────────
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

export function buildChatRequest(opts: {
  baseURL: string; model: string; key: string;
  messages: ChatMessage[]; stream: boolean;
  tools?: unknown[]; temperature?: number;
}) {
  const base = opts.baseURL.replace(/\/+$/, '');
  const body: Record<string, any> = {
    model: opts.model,
    messages: opts.messages,
    stream: opts.stream,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  return {
    url: `${base}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.key}` },
    body: JSON.stringify(body),
  };
}

// ── HTTP 错误中文映射 ──────────────────────────────────────
export function mapHttpError(status: number): string {
  switch (status) {
    case 400: return '请求格式错误（400）——参数不合法';
    case 401: return '密钥无效或未配置（401）——检查 /key';
    case 402: return '账户余额不足（402）——需充值';
    case 403: return '无权限访问该模型（403）';
    case 404: return '接口或模型不存在（404）——检查 baseURL 与 model';
    case 413: return '请求过大（413）——上下文超限，建议 /compact';
    case 429: return '请求限流（429）——稍后重试或降级模型';
    case 500: return '模型服务端错误（500）';
    case 503: return '服务暂不可用（503）——自动重试中';
    default: return `请求失败（HTTP ${status}）`;
  }
}

// ── 密钥脱敏（日志/审计安全：绝不回显明文）──────────────────
export function maskKey(k: string): string {
  if (!k) return '(未配置)';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

// 便捷：SHA-256（供审计指纹等）
export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
