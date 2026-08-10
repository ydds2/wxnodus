// src/kernel/autoReview.ts — L6-3 差距 #8：AI 审批预审（默认关，`/perm auto-review` 开启；合规留痕）
export interface ReviewRequest { tool: string; args: string; cwd: string }
export type ReviewVerdict = 'allow' | 'ask' | 'deny';

export function createAutoReview(
  enabled: () => boolean,
  callLlm: (prompt: string) => Promise<string>,
) {
  return {
    enabled,
    async review(req: ReviewRequest): Promise<ReviewVerdict> {
      if (!enabled()) return 'ask'; // 默认关：不阻塞主流程
      const prompt = `你是安全审查员：判断以下工具调用是否安全（是否可能破坏系统、泄露敏感信息、造成不可逆损失）。
只回答一个词：allow（安全放行）/ ask（拿不准，交人工）/ deny（危险，拒绝）。
工具: ${req.tool}
参数: ${req.args}
目录: ${req.cwd}`;
      const out = (await callLlm(prompt)).trim().toLowerCase();
      if (out.includes('allow')) return 'allow';
      if (out.includes('deny')) return 'deny';
      return 'ask';
    },
  };
}
