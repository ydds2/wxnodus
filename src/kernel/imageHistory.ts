// src/kernel/imageHistory.ts — 多模态历史回显
// 图片只在当次 API 调用的内存消息里（DB 存纯文本）——后续轮次上下文丢失"看过什么图"。
// 本模块：图片轮次异步经 GLM-4V 生成摘要，追加进该会话最后一条 user 消息
// （working() 历史自然带入下一轮；UI 会话视图同步可见模型对图的理解）。
// W1-06：摘要同时写入 Black Hole Memory repository（provenance 'image'，session 作用域），
// 走事务索引——失败静默降级（不阻断对话，消息仍保留 messages 表路径）。
// 红线：无 key 不调用 AI（不假装）；失败静默降级（不阻断对话）。
import type { Db } from '../store/db.js';

export interface ImagePart {
  dataUrl: string;
  mime: string;
}

const SUMMARY_MAX = 200;

// 真实摘要实现：dataUrl 直传 GLM-4V（describeImage 已支持 data:URL）
async function realSummarize(images: ImagePart[], apiKeyEnc: string | null): Promise<string | null> {
  const { describeImage } = await import('./vision.js');
  if (images.length === 1) {
    return describeImage(images[0]!.dataUrl, apiKeyEnc, '用不超过 150 字的中文描述这张图片的内容（画面主体、文字、布局）。只输出描述。');
  }
  // 多张：GLM-4V 单次支持多图但逐张会多轮调用——简洁做法：第一张为主图描述，其余数量注明
  const first = await describeImage(images[0]!.dataUrl, apiKeyEnc, '用不超过 100 字的中文描述这张图片的核心内容。只输出描述。');
  return first ? `${first}（另附 ${images.length - 1} 张图片未逐张描述）` : null;
}

/**
 * 图片摘要入历史：把摘要追加进 sessionId 最后一条 user 消息。
 * @param summarize 可注入的摘要实现（测试用）；缺省走 GLM-4V
 * @returns 是否成功写入摘要（无 key/失败返回 false，消息保持原文）
 */
export async function attachImageSummary(opts: {
  db: Db;
  sessionId: string;
  images: ImagePart[];
  apiKeyEnc: string | null;
  summarize?: (images: ImagePart[]) => Promise<string | null>;
}): Promise<boolean> {
  const { db, sessionId, images, apiKeyEnc } = opts;
  if (!images?.length) return false;
  // 红线：无 key 且无注入实现 → 不调用 AI（不假装生成）
  const summarize = opts.summarize ?? (apiKeyEnc ? (imgs: ImagePart[]) => realSummarize(imgs, apiKeyEnc) : null);
  if (!summarize) return false;
  try {
    const raw = await summarize(images);
    if (!raw?.trim()) return false;
    const summary = `\n[附加图片] ${raw.trim().slice(0, SUMMARY_MAX)}`;
    const r = db.prepare(
      `UPDATE messages SET content = content || ? WHERE id = (SELECT MAX(id) FROM messages WHERE session_id=? AND role='user')`
    ).run(summary, sessionId);
    // W1-06：摘要沉淀进 memory repository（image provenance + session scope）——fail-soft
    try {
      const { openMemoryRepository } = await import('../infrastructure/sqlite/memoryRepository.js');
      const repo = openMemoryRepository(db, { now: () => Date.now(), idFactory: prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
      repo.append({
        role: 'assistant',
        content: raw.trim().slice(0, SUMMARY_MAX),
        salience: 0.6,
        retention: { class: 'session', retainUntil: null },
        provenance: {
          sourceType: 'image', sourceId: `image-summary-${Date.now()}`, sourceUri: `session://${sessionId}`,
          capturedAt: new Date().toISOString(), actorId: 'image-summary',
          correlationId: sessionId, policySnapshotId: 'local', sourceTrust: 0.7,
        },
      }, { sessionId });
    } catch { /* memory repository 不可用：仅 messages 表路径 */ }
    return r.changes > 0;
  } catch {
    return false; // 失败静默降级，不阻断对话
  }
}
