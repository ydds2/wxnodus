// src/kernel/sessionImport.ts — V4 P4-4：会话互操作（export Markdown + 竞品会话导入）
// 机制参考（不抄实现）：kimi /import-from-cc-codex 实证「从 Claude Code/Codex 迁移会话」
// 是有效增长手段；claude --fork-session / codex resume 的会话文件均为 JSONL。
// 嗅探三家格式（按结构特征，绝不按文件名猜测）：
//   ① Claude Code ~/.claude/projects/*/*.jsonl：行 {type:'user'|'assistant', message:{role, content: string | parts[]}, timestamp}
//   ② Codex ~/.codex/sessions/**/rollout-*.jsonl：行 {type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text'|'text', text}]}}
//      （早版直接 {type:'message', role, content:[...]}——两种都认）
//   ③ wxnodus /export --jsonl：行 {id, role, content, tool_call_id, archived, ts, session_id}
// content parts 提取：text 块取 text；tool_use/tool_result 块以「[工具 name] 摘要」文本化（可读性优先，不丢事实）。

export interface ImportedMessage { role: 'user' | 'assistant' | 'system'; content: string; ts?: number }
export interface ParsedSession {
  kind: 'claude' | 'codex' | 'wxnodus' | 'unknown';
  messages: ImportedMessage[];
}

/** parts 数组 → 文本（Claude/Codex content 块文本化——text 原样，工具块摘要化） */
function partsToText(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  const out: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const b = p as Record<string, any>;
    if (typeof b.text === 'string' && b.text.trim()) out.push(b.text);
    else if (b.type === 'tool_use') out.push(`[工具调用 ${b.name ?? '?'}] ${safeJson(b.input)}`);
    else if (b.type === 'tool_result') {
      const c = typeof b.content === 'string' ? b.content : partsToText(b.content);
      out.push(`[工具结果] ${c.slice(0, 500)}`);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push(`[思考] ${b.thinking.slice(0, 300)}`);
  }
  return out.join('\n');
}

const safeJson = (v: unknown): string => {
  try { return JSON.stringify(v)?.slice(0, 300) ?? ''; } catch { return ''; }
};

const normRole = (r: string): ImportedMessage['role'] =>
  r === 'assistant' || r === 'system' ? r : 'user';

/** JSONL 逐行解析（坏行跳过——诚实计数由调用方对比行数） */
function parseLines(text: string): Array<Record<string, any>> {
  return text.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l) as Record<string, any>; } catch { return null; } })
    .filter((e): e is Record<string, any> => e !== null);
}

/**
 * 嗅探并解析外部会话 JSONL。识别优先级：结构特征逐行探测；两行以上命中即判定；
 * 无法判定格式返回 kind='unknown' + 空 messages（调用方按自有格式/纯文本兜底）。
 */
export function parseExternalSessionJsonl(text: string): ParsedSession {
  const lines = parseLines(text);
  if (lines.length < 2) return { kind: 'unknown', messages: [] };

  // ① wxnodus 自有：行含 role+content 且（id 或 ts 或 tool_call_id 任一）且无 message/payload 包裹
  const wxnodusHits = lines.filter(l =>
    typeof l.role === 'string' && typeof l.content === 'string' && !l.message && !l.payload).length;
  if (wxnodusHits >= Math.ceil(lines.length * 0.8)) {
    return {
      kind: 'wxnodus',
      messages: lines.filter(l => typeof l.role === 'string' && typeof l.content === 'string')
        .map(l => ({ role: normRole(String(l.role)), content: String(l.content), ts: typeof l.ts === 'number' ? l.ts : undefined })),
    };
  }

  // ② Claude Code：行含 message 对象（{role, content}）
  const claudeHits = lines.filter(l => l.message && typeof l.message === 'object'
    && typeof (l.message as any).role === 'string').length;
  if (claudeHits >= 2) {
    const messages: ImportedMessage[] = [];
    for (const l of lines) {
      const m = l.message as Record<string, any>;
      if (!m || typeof m.role !== 'string') continue;
      const content = partsToText(m.content);
      if (!content.trim()) continue;
      const ts = typeof l.timestamp === 'string' ? Date.parse(l.timestamp) : (typeof l.timestamp === 'number' ? l.timestamp : undefined);
      messages.push({ role: normRole(String(m.role)), content, ts: Number.isFinite(ts) ? ts : undefined });
    }
    return { kind: 'claude', messages };
  }

  // ③ Codex rollout：type=response_item 包 payload.message，或直接 type=message
  const codexPayloadHits = lines.filter(l => l.type === 'response_item' && l.payload && typeof l.payload === 'object').length;
  const codexDirectHits = lines.filter(l => l.type === 'message' && typeof l.role === 'string').length;
  if (codexPayloadHits >= 2 || codexDirectHits >= 2) {
    const messages: ImportedMessage[] = [];
    for (const l of lines) {
      const m = (l.payload && typeof l.payload === 'object') ? l.payload as Record<string, any> : l;
      if (m?.type !== 'message' || typeof m.role !== 'string') continue;
      const content = partsToText(m.content);
      if (!content.trim()) continue;
      messages.push({ role: normRole(String(m.role)), content });
    }
    return { kind: 'codex', messages };
  }

  return { kind: 'unknown', messages: [] };
}

// ── Markdown 导出（/export --md——claude /export markdown 对齐，实现原创） ──

export interface MarkdownRow { role: string; content: string; tool_call_id?: string | null; ts?: number | null }

/** 会话 → Markdown（角色标题 + 内容 + 相对时间；工具调用折叠为引用块） */
export function renderSessionMarkdown(sessionId: string, rows: MarkdownRow[], meta?: { title?: string }): string {
  const label: Record<string, string> = { user: '👤 用户', assistant: '🤖 助手', system: '⚙ 系统' };
  const out: string[] = [`# 会话 ${sessionId}${meta?.title ? `：${meta.title}` : ''}`, ''];
  for (const r of rows) {
    const time = typeof r.ts === 'number' && r.ts > 0 ? ` · ${new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}` : '';
    out.push(`## ${label[r.role] ?? r.role}${time}`, '');
    if (r.role === 'assistant' && r.tool_call_id) {
      out.push('> 工具调用消息', '');
    }
    out.push(String(r.content ?? ''), '');
  }
  out.push('---', '', `共 ${rows.length} 条消息 · 由 wxnodus /export --md 导出`);
  return out.join('\n') + '\n';
}
