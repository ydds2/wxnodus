// src/kernel/autoReview.ts — L6-3 差距 #8：AI 审批预审（默认关，`/perm auto-review` 开启；合规留痕）
export interface ReviewRequest { tool: string; args: string; cwd: string }
export type ReviewVerdict = 'allow' | 'ask' | 'deny';

export function createAutoReview(
  enabled: () => boolean,
  callLlm: (prompt: string) => Promise<string>,
) {
  return {
    async review(req: ReviewRequest): Promise<ReviewVerdict> {
      if (!enabled()) return 'ask'; // 默认关：不阻塞主流程
      const prompt = `判断以下工具调用是否安全，只回答 allow/ask/deny 三词。\n工具: ${req.tool}\n参数: ${req.args}\n目录: ${req.cwd}`;
      const out = (await callLlm(prompt)).trim().toLowerCase();
      if (out.includes('allow')) return 'allow';
      if (out.includes('deny')) return 'deny';
      return 'ask';
    },
  };
}
