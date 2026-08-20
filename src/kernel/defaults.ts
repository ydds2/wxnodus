// src/kernel/defaults.ts — 默认值单一事实源（开放兼容：切换模型/厂商不再改代码）
// 解析优先级（文档化）：settings 配置（用户显式设置）> 环境变量（WXNODUS_MODEL /
// WXNODUS_BASE_URL / WXNODUS_API_KEY / WXNODUS_DATA_DIR）> 内置默认值。
// 历史版本在 12+ 处散落写死 'deepseek-v4-flash' 与 'https://api.deepseek.com/v1'，
// 换默认厂商需全部同步——本模块收敛为唯一出口。

export const FALLBACK_MODEL = 'deepseek-v4-flash';
export const FALLBACK_BASE_URL = 'https://api.deepseek.com/v1';

/** 环境变量覆盖（运行时读取，测试可注入 process.env） */
export function envDefaultModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.WXNODUS_MODEL?.trim() || undefined;
}

export function envDefaultBaseURL(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.WXNODUS_BASE_URL?.trim() || undefined;
}

/**
 * 解析默认模型：settings.model（合法 modelId）> WXNODUS_MODEL > 内置默认。
 * 校验委托给调用方（MODEL_CATALOG 合法性判断在 providers.ts，避免循环依赖）。
 */
export function resolveDefaultModel(settings: { model?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return settings.model?.trim() || envDefaultModel(env) || FALLBACK_MODEL;
}

/** 解析默认端点：settings.baseURL > WXNODUS_BASE_URL > 内置默认 */
export function resolveDefaultBaseURL(settings: { baseURL?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return settings.baseURL?.trim() || envDefaultBaseURL(env) || FALLBACK_BASE_URL;
}
