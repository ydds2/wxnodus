// src/kernel/vision.ts — L6-2 视觉理解（/vision /img /video 共用）
// 设计：本地图片 base64 直传 / URL 透传 → 多模态模型（默认 glm-4v-flash 免费）
//       端点可经环境变量覆盖（本地化为准，默认智谱；自建网关/OpenRouter 等
//       OpenAI 兼容端点可用 WXNODUS_VISION_BASE_URL/MODEL/KEY 覆盖）
import { decryptKey } from './providers.js';

const visionBase = () => process.env.WXNODUS_VISION_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4';
const visionModel = () => process.env.WXNODUS_VISION_MODEL ?? 'glm-4v-flash';
const visionKey = (enc: string | null): string | null => {
  // 环境变量 key 优先（自建网关/代理场景），否则解密配置的密钥
  if (process.env.WXNODUS_VISION_KEY) return process.env.WXNODUS_VISION_KEY;
  if (!enc) return null;
  return decryptKey(enc);
};

const extractText = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return content.trim() ? content.trim() : null;
  }
  if (Array.isArray(content)) {
    const text = content.map(c => (c as any)?.text ?? '').join('').trim();
    return text || null;
  }
  return null;
};

export async function describeImage(target: string, apiKeyEnc: string | null, prompt?: string): Promise<string | null> {
  const key = visionKey(apiKeyEnc);
  if (!key) return null;
  try {
    let imageUrl: string;
    if (target.startsWith('data:')) {
      imageUrl = target; // data:URL 直传（多模态历史回显复用）
    } else if (/^https?:\/\//i.test(target)) {
      imageUrl = target;
    } else {
      const { readFileSync } = await import('node:fs');
      const { extname } = await import('node:path');
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const mime = mimeMap[extname(target).toLowerCase()] ?? 'image/png';
      imageUrl = `data:${mime};base64,` + readFileSync(target).toString('base64');
    }
    const resp = await fetch(`${visionBase().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: visionModel(),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt ?? '描述这张图片的内容，包括文字、布局与视觉特征' }, { type: 'image_url', image_url: { url: imageUrl } }] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) return null;
    const j = await resp.json() as any;
    return extractText(j?.choices?.[0]?.message?.content);
  } catch {
    return null;
  }
}

// 文本模型综合（视频帧描述序列 → 项目级分析报告）
// 默认 glm-4-flash（免费）——glm-4.5 需付费额度（429 余额不足）
export async function analyzeText(prompt: string, apiKeyEnc: string | null): Promise<string | null> {
  const key = visionKey(apiKeyEnc);
  if (!key) return null;
  try {
    const resp = await fetch(`${visionBase().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: process.env.WXNODUS_TEXT_MODEL ?? 'glm-4-flash',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) return null;
    const j = await resp.json() as any;
    return extractText(j?.choices?.[0]?.message?.content);
  } catch {
    return null;
  }
}
