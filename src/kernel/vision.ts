// src/kernel/vision.ts — L6-2 GLM-4V 视觉理解（/vision /img 共用）
// 设计：本地图片 base64 直传 / URL 透传 → glm-4v-flash（免费多模态）
export async function describeImage(target: string, apiKeyEnc: string | null): Promise<string | null> {
  if (!apiKeyEnc) return null;
  try {
    const { decryptKey } = await import('./providers.js');
    const key = decryptKey(apiKeyEnc);
    if (!key) return null;
    let imageUrl: string;
    if (/^https?:\/\//i.test(target)) {
      imageUrl = target;
    } else {
      const { readFileSync } = await import('node:fs');
      const { extname } = await import('node:path');
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const mime = mimeMap[extname(target).toLowerCase()] ?? 'image/png';
      imageUrl = `data:${mime};base64,` + readFileSync(target).toString('base64');
    }
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'glm-4v-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: '描述这张图片的内容，包括文字、布局与视觉特征' }, { type: 'image_url', image_url: { url: imageUrl } }] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) return null;
    const j = await resp.json() as any;
    const text = j?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}
