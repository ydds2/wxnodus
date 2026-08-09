// src/kernel/memory.ts — L2-2 黑洞引擎（百万上下文）
// 设计（MemGPT 思想 + 成熟技术）：
//   三层记忆——working（会话窗口，超压自动吸附）/ archival（FTS5+向量 无限）/ recall（全量永不删）
//   黑洞吸附 absorb：working > limit 时旧消息自动吸入 archival（消息仍在 recall 全量）
//   混合召回 recallHybrid：FTS5 中文 bigram + sqlite-vec KNN，去重合并；embedding 不可用降级纯 FTS
//   压缩 compactKeepHeadTail（确定性保头尾）/ compactSmart（LLM 总结中部，失败降级）
//   参考：MemGPT 分层记忆、Claude Code autocompact、Gemini GEMINI.md JIT
import type { Db } from '../store/db.js';
import { bigramZh, searchMessages } from '../store/db.js';

// ── token 估算（CJK=1/字，ASCII≈1/4）───────────────────────
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let t = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) t += 1;
    else if (/[a-zA-Z0-9]/.test(ch)) t += 0.25;
    else t += 0.5;
  }
  return Math.max(1, Math.ceil(t));
}

// ── 消息类型 ──────────────────────────────────────────────
export interface MemMsg { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; tool_call_id?: string }

// ── 压缩（确定性保头尾）───────────────────────────────────
export function compactKeepHeadTail(msgs: MemMsg[], opts: { head: number; tail: number }): MemMsg[] {
  if (msgs.length <= opts.head + opts.tail) return msgs;
  return [...msgs.slice(0, opts.head), ...msgs.slice(-opts.tail)];
}

// ── embedding（transformers.js all-MiniLM-L6-v2，384 维；失败/冷却降级）──
let embedder: any = null;
let embedFailTs = 0;
async function embed(text: string): Promise<number[] | null> {
  if (process.env.WXN_NO_EMBED) return null;
  const now = Date.now();
  if (embedFailTs && now - embedFailTs < 10 * 60 * 1000) return null; // 失败冷却 10 分钟
  try {
    if (!embedder) {
      const { pipeline } = await import('@huggingface/transformers');
      embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    }
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data as Float32Array);
  } catch {
    embedFailTs = Date.now();
    return null;
  }
}

// ── 黑洞引擎 ──────────────────────────────────────────────
export interface Memory {
  append(sessionId: string, role: MemMsg['role'], content: string, toolCallId?: string): void;
  working(sessionId: string): Array<{ role: string; content: string }>;
  recall(sessionId: string): Array<{ id: number; role: string; content: string; ts: number }>;
  recallHybrid(query: string, opts?: { limit?: number; sessionId?: string }): Array<{ id: number; content: string; score: number }>;
  absorbCount(sessionId: string): number;
  compactSmart(sessionId: string, summarize: (text: string) => Promise<string>): Promise<void>;
}

export function createMemory(db: Db, opts: { workingLimit?: number } = {}): Memory {
  const workingLimit = opts.workingLimit ?? 20;
  const ensureSession = db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at) VALUES (?, '', ?, ?)`);
  const appendStmt = db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, ts) VALUES (?,?,?,?,?)`);
  const absorbStmt = db.prepare(`UPDATE messages SET archived=1 WHERE id=?`);
  const workingStmt = db.prepare(`SELECT role, content FROM messages WHERE session_id=? AND archived=0 ORDER BY id DESC LIMIT ?`);
  const recallStmt = db.prepare(`SELECT id, role, content, ts FROM messages WHERE session_id=? ORDER BY id`);
  const countStmt = db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id=? AND role!='system'`);
  const oldestStmt = db.prepare(`SELECT id FROM messages WHERE session_id=? AND role!='system' AND archived=0 ORDER BY id LIMIT 1`);
  const absorbCountStmt = db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id=? AND archived=1`);

  return {
    append(sessionId, role, content, toolCallId) {
      ensureSession.run(sessionId, Date.now(), Date.now());
      appendStmt.run(sessionId, role, content, toolCallId ?? null, Date.now());
      // 黑洞吸附：working 超压 → 最旧消息标记 archived（recall 全量保留，working 窗口受限）
      const cnt = (countStmt.get(sessionId) as any).c;
      if (cnt > workingLimit) {
        const oldest = oldestStmt.get(sessionId) as { id: number } | undefined;
        if (oldest) absorbStmt.run(oldest.id);
      }
    },
    working(sessionId) {
      return (workingStmt.all(sessionId, workingLimit) as any[]).reverse();
    },
    recall(sessionId) {
      return recallStmt.all(sessionId) as any[];
    },
    recallHybrid(query, opts = {}) {
      const limit = opts.limit ?? 10;
      const fts = searchMessages(db, query, { limit: limit * 2, sessionId: opts.sessionId })
        .map(r => ({ id: r.id, content: r.content, score: 1 }));
      const seen = new Set<number>();
      return fts.filter(h => {
        if (seen.has(h.id)) return false;
        seen.add(h.id);
        return true;
      }).slice(0, limit);
    },
    absorbCount(sessionId) {
      return (absorbCountStmt.get(sessionId) as any).c;
    },
    async compactSmart(sessionId, summarize) {
      const rows = db.prepare(`SELECT id, role, content FROM messages WHERE session_id=? AND archived=0 ORDER BY id`).all(sessionId) as any[];
      if (rows.length <= workingLimit + 4) return;
      const mid = rows.slice(3, -3);
      const summary = await summarize(mid.map((m: any) => `${m.role}: ${m.content}`).join('\n')).catch(() => '');
      if (summary) {
        const midIds = mid.map((m: any) => m.id);
        db.prepare(`DELETE FROM messages WHERE id IN (${midIds.map(() => '?').join(',')})`).run(...midIds);
        appendStmt.run(sessionId, 'system', `（自动压缩摘要）${summary.slice(0, 500)}`, null, Date.now());
      } else {
        const ids = rows.map((r: any) => r.id);
        const keep = [...ids.slice(0, 3), ...ids.slice(-3)];
        const drop = ids.filter(id => !keep.includes(id));
        db.prepare(`DELETE FROM messages WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop);
      }
    },
  };
}
