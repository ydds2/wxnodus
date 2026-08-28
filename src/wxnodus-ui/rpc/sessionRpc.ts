// src/wxnodus-ui/rpc/sessionRpc.ts — C-02 拆分：session 无状态 RPC 四件套
// （sessionList/sessionTail/sessionMostRecent/sessionTitle）
// 2026-08-19 从 wxGateway 提取——纯 adapter 调用零实例态（触碰 currentSessionId/running
// 的 sessionDelete/ActiveList 等留在网关）；结构类型子集避免与 wxGateway 互 import。
export interface SessionRpcKernel {
  adapter: { data: { sessions: SessionsLike; messages: MessagesLike } }
}

interface SessionsLike {
  list(limit: number): Array<Record<string, unknown>> | any[];
  mostRecent(): Record<string, unknown> | null | any;
  rename(id: string, title: string): unknown;
}

interface MessagesLike {
  rows(sessionId: string): Array<Record<string, unknown>> | any[];
}

export async function sessionListRpc(kernel: SessionRpcKernel, params: Record<string, unknown>): Promise<unknown> {
  const current = String(params.current_session_id ?? '')
  const limit = Math.min(Number(params.limit ?? 200) || 200, 500)
  let rows: any[] = []
  try {
    rows = kernel.adapter.data.sessions.list(limit)
  } catch {
    rows = []
  }
  const sessions = rows.map((r: any) => ({
    id: String(r.id),
    title: String(r.title ?? ''),
    current: String(r.id) === current,
    created_at: Number(r.created_at ?? 0) / 1000,
    updated_at: Number(r.updated_at ?? 0) / 1000,
    message_count: Number(r.message_count ?? 0),
    ...(typeof r.cost_usd === 'number' ? { cost_usd: r.cost_usd } : {}),
  }))
  return { sessions }
}

export async function sessionTailRpc(kernel: SessionRpcKernel, params: Record<string, unknown>): Promise<unknown> {
  // 会话尾部消息（会话浏览器惰性展开预览，codex resume_picker 惰性加载对标）
  const id = String(params.session_id ?? '')
  const limit = Math.min(Math.max(Number(params.limit ?? 6) || 6, 1), 20)
  let rows: any[] = []
  try {
    rows = kernel.adapter.data.messages.rows(id)
  } catch {
    rows = []
  }
  const tail = rows
    .filter((r: any) => !r.archived && (r.role === 'user' || r.role === 'assistant'))
    .slice(-limit)
    .map((r: any) => ({ role: String(r.role), text: String(r.content ?? '') }))
  return { messages: tail }
}

export async function sessionMostRecentRpc(kernel: SessionRpcKernel): Promise<unknown> {
  let row: any = null
  try {
    row = kernel.adapter.data.sessions.mostRecent() ?? null
  } catch {
    row = null
  }
  if (!row) return { session_id: null }
  return {
    session_id: String(row.id),
    title: String(row.title ?? ''),
    started_at: Number(row.created_at ?? 0) / 1000,
  }
}

export async function sessionTitleRpc(kernel: SessionRpcKernel, params: Record<string, unknown>): Promise<unknown> {
  const id = String(params.session_id ?? '')
  const title = String(params.title ?? '')
  kernel.adapter.data.sessions.rename(id, title)
  return { title }
}
