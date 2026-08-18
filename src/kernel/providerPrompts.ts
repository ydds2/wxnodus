// src/kernel/providerPrompts.ts — 分族提示词（supremacy 1.1 / 缺陷 A-02 落地，2026-08-18）
// 机制参考：gemini 按模型分族的系统提示段（provider 语义差异注入）——实现原创。
// 本模块承载中文 provider 专属文本（systemPrompt.ts 零 CJK 红线 kf-029 不破——提示段经
// buildSystemPrompt 的 providerPrompt 参数注入，保持前缀稳定：provider 由 model/设置派生，
// 会话内不变 → DeepSeek 上下文缓存前缀不受影响）。
// 内容口径：只写各 provider 的**真实 API 行为差异**（推理字段回传/缓存/窗口/视觉），
// 不写营销性文案——诚实工程红线。
import { MODEL_CATALOG, detectProvider } from './providers.js';

export interface ProviderPrompt {
  provider: string;
  label: string;
  body: string;
}

const DEEPSEEK_BODY = [
  '【DeepSeek 专属提示】',
  '1. 本模型的推理字段（reasoning_content）若上游传入，必须原样回传，不得丢弃或改写（否则请求会被 400 拒绝）。',
  '2. 上下文前缀缓存自动生效：保持对话历史前缀一致可显著降费——不要无谓改写既有消息。',
  '3. 默认上下文窗口 64k（V4 Pro 128k）：长输出用工具分页/重定向读取，避免一次性撑满。',
  '4. 语言：优先中文回答；代码与命令保持原样。',
].join('\n');

const KIMI_BODY = [
  '【Kimi（Moonshot）专属提示】',
  '1. 高速档（k2.7-highspeed）适合工具密集回合；K3-256k 大窗口可减少压缩频率。',
  '2. 上下文窗口 128k/256k：长会话少压缩、长输出可适度全量读取。',
  '3. 语言：优先中文回答；代码与命令保持原样。',
].join('\n');

const ZHIPU_BODY = [
  '【智谱 GLM 专属提示】',
  '1. GLM-4.5 支持推理模式（thinking）；GLM-4V 是视觉模型（图片注入能力）。',
  '2. 推理字段（reasoning_content）若上游传入必须原样回传。',
  '3. 语言：优先中文回答；代码与命令保持原样。',
].join('\n');

/** provider 专属提示段（未知 provider → null，走通用提示） */
export function providerPromptFor(provider: string): ProviderPrompt | null {
  switch (provider) {
    case 'deepseek': return { provider: 'deepseek', label: 'DeepSeek', body: DEEPSEEK_BODY };
    case 'kimi': return { provider: 'kimi', label: 'Kimi', body: KIMI_BODY };
    case 'zhipu': return { provider: 'zhipu', label: 'GLM', body: ZHIPU_BODY };
    default: return null;
  }
}

/** 由模型与端点解析 provider（目录 modelId 优先，其次 baseURL 探测） */
export function resolveProviderForPrompt(model: string | undefined, baseURL: string | undefined): string {
  const m = MODEL_CATALOG.find(x => x.modelId === model);
  if (m) return m.provider;
  return detectProvider(baseURL);
}
