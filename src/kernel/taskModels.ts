// src/kernel/taskModels.ts — 小模型任务档（supremacy 1.2 / 缺陷 A-03 落地，2026-08-18）
// 机制参考：crush large/small 双模型分档（标题走小模型）——实现原创。
// settings.titleModel / settings.summaryModel：配置后标题/摘要等轻任务路由到小模型，
// 主模型只干正事（省 token 省成本）；未配置/失败/无密钥一律回退主路径（诚实降级）。
export function resolveTaskModel(settings: Record<string, any> | undefined, kind: 'title' | 'summary'): string | null {
  const key = kind === 'title' ? 'titleModel' : 'summaryModel';
  const v = String(settings?.[key] ?? '').trim();
  return v || null;
}

export interface TaskCallOnce { (system: string, user: string): Promise<string | null> }

/** 标题生成（≤20 字中文；异常/空返回 null——调用方回退切片标题） */
export async function generateTitle(prompt: string, callOnce: TaskCallOnce): Promise<string | null> {
  try {
    const t = await callOnce(
      '你是标题生成器：为下面的用户请求生成一个 ≤20 字的中文标题（不要引号、不要解释，只输出标题本身）。',
      prompt.slice(0, 2000),
    );
    const clean = String(t ?? '').trim().replace(/^["「]|["」]$/g, '').slice(0, 20);
    return clean || null;
  } catch {
    return null;
  }
}

/** 摘要生成（≤200 字要点；异常/空返回 null）——digest/蒸馏等轻任务复用 */
export async function generateSummary(text: string, callOnce: TaskCallOnce): Promise<string | null> {
  try {
    const t = await callOnce(
      '你是摘要器：把下面的内容压缩为 ≤200 字的中文要点（保留结论、数字、未完成事项）。只输出摘要。',
      text.slice(0, 20_000),
    );
    const clean = String(t ?? '').trim().slice(0, 200);
    return clean || null;
  } catch {
    return null;
  }
}
