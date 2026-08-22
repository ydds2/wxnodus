// src/kernel/historyNormalize.ts — 历史归一化（kimi-cli normalize_history 机制参考·实现原创）
// 发请求前合并相邻同角色消息：steer 注入/首轮多条 system/DB 连续同角色行造成的碎片
// 会打断 DeepSeek 前缀缓存并浪费请求行数。纯函数、确定性、幂等（同输入恒同输出——
// 前缀缓存字节稳定性前提）。协议约束（OpenAI function calling）：tool 消息与带
// tool_calls 的 assistant 绝不合并（tool_call_id 配对唯一性）；只合并 user+user 与 system+system。
export type NormalizableMessage = {
  role: string;
  content: string | Array<Record<string, any>> | null;
  [key: string]: unknown;
};

const toParts = (c: NormalizableMessage['content']): Array<Record<string, any>> =>
  typeof c === 'string' ? [{ type: 'text', text: c }] : (c ?? []);

const mergeContent = (
  a: NormalizableMessage['content'],
  b: NormalizableMessage['content'],
): NormalizableMessage['content'] => {
  // 双字符串：保持字符串形态（最常见路径——repr 不变）
  if (typeof a === 'string' && typeof b === 'string') return `${a}
${b}`;
  // 任一方是 parts 数组：统一转 parts 拼接（确定性转换）
  return [...toParts(a), ...toParts(b)];
};

const mergeable = (m: NormalizableMessage): boolean =>
  (m.role === 'user' || m.role === 'system') && !m.tool_calls && !m.tool_call_id;

export function mergeAdjacentMessages<T extends NormalizableMessage>(messages: T[]): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && mergeable(m) && mergeable(prev)) {
      out[out.length - 1] = { ...prev, content: mergeContent(prev.content, m.content) };
    } else {
      out.push(m);
    }
  }
  return out;
}
