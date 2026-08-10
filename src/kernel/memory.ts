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

// ── 消息序列 token 估算（自动压缩触发阈值用）────────────────
// 消息内容文本化：字符串原样；数组（OpenAI 多模态 parts）→ 文本段拼接 + 图片占位
// （图片 dataUrl 基编码体量巨大，进摘要/估算会撑爆上下文——占位符计数即可）
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : p?.type === 'image_url' ? '[图片]' : '[附件]')).join('\n');
  }
  return String(content ?? '');
}

export function estimateMessagesTokens(msgs: Array<{ role: string; content: unknown | null }>): number {
  let t = 0;
  for (const m of msgs) {
    t += estimateTokens(contentToText(m.content));
    t += m.role === 'tool' ? 12 : 4; // 角色/工具调用开销
  }
  return t;
}

// ── 内存消息压缩（自动压缩用）：保头尾 + LLM 摘要中部，失败降级规则截断 ──
// 与 compactSmart（db 层）对应——本函数操作 agent 的内存消息数组
export async function compactMessages(
  msgs: MemMsg[],
  summarize: (text: string) => Promise<string>,
  opts: { head?: number; tail?: number } = {},
): Promise<MemMsg[]> {
  const head = opts.head ?? 3;
  const tail = opts.tail ?? 3;
  if (msgs.length <= head + tail + 2) return msgs;
  const keepHead = msgs.slice(0, head);
  const keepTail = msgs.slice(-tail);
  const mid = msgs.slice(head, -tail);
  const summary = await summarize(mid.map(m => `${m.role}: ${contentToText(m.content).slice(0, 300)}`).join('\n')).catch(() => '');
  if (summary) {
    return [...keepHead, { role: 'system', content: `（自动压缩摘要）${summary.slice(0, 500)}` }, ...keepTail];
  }
  // LLM 摘要失败：确定性降级——每轮只留首行
  const condensed: MemMsg[] = [];
  let lastRole = '';
  for (const m of mid) {
    if (m.role !== 'tool' && m.role !== lastRole) {
      const firstLine = String(m.content).split('\n')[0]!.slice(0, 120);
      condensed.push({ role: m.role, content: firstLine });
    }
    lastRole = m.role;
  }
  return [...keepHead, { role: 'system', content: `（压缩省略 ${mid.length} 条中间消息）` }, ...condensed.slice(-10), ...keepTail];
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
  recallHybrid(query: string, opts?: { limit?: number; sessionId?: string }): Promise<Array<{ id: number; content: string; score: number }>>;
  absorbCount(sessionId: string): number;
  compactSmart(sessionId: string, summarize: (text: string) => Promise<string>): Promise<void>;
  /** 会话无标题时用给定标题命名（自动标题） */
  setTitleIfEmpty(sessionId: string, title: string): void;
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
  // F5 修复：向量写入与 KNN 查询（vec 不可用时降级——prepare 抛错即禁用）
  const insertVecStmt = (() => { try { return db.prepare(`INSERT OR IGNORE INTO archival_vec (id, embedding) VALUES (?, ?)`); } catch { return null; } })();
  const knnStmt = (() => { try { return db.prepare(`SELECT id FROM archival_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`); } catch { return null; } })();

  // F5：异步向量写入（fire-and-forget，失败静默；embedding 不可用走冷却）
  const embedAndStore = (messageId: number, content: string) => {
    void (async () => {
      try {
        if (!insertVecStmt) return;
        const v = await embed(content.slice(0, 2000));
        if (!v) return;
        insertVecStmt.run(messageId, JSON.stringify(v));
      } catch { /* 向量写入失败静默（纯 FTS 兜底） */ }
    })();
  };

  return {
    append(sessionId, role, content, toolCallId) {
      ensureSession.run(sessionId, Date.now(), Date.now());
      const info = appendStmt.run(sessionId, role, content, toolCallId ?? null, Date.now());
      // F5：消息异步写入向量索引（黑洞混合召回的数据源）
      if (role === 'user' || role === 'assistant') {
        embedAndStore(Number(info.lastInsertRowid), String(content));
      }
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
    async recallHybrid(query, opts = {}) {
      const limit = opts.limit ?? 10;
      const fts = searchMessages(db, query, { limit: limit * 2, sessionId: opts.sessionId })
        .map(r => ({ id: r.id, content: r.content, score: 1 }));
      const seen = new Set<number>();
      const out = fts.filter(h => {
        if (seen.has(h.id)) return false;
        seen.add(h.id);
        return true;
      });
      // F5：向量融合——FTS 命中不足时用 KNN 补充语义近似命中（embedding 不可用/查询失败降级纯 FTS）
      if (out.length < limit && knnStmt) {
        const qv = await embed(query.slice(0, 2000)).catch(() => null);
        if (qv) {
          try {
            const knn = knnStmt.all(JSON.stringify(qv), limit - out.length) as Array<{ id: number }>;
            for (const k of knn) {
              if (seen.has(k.id)) continue;
              const row = db.prepare(`SELECT id, content FROM messages WHERE id=?`).get(k.id) as { id: number; content: string } | undefined;
              if (!row) continue;
              seen.add(row.id);
              out.push({ id: row.id, content: row.content, score: 0.8 });
              if (out.length >= limit) break;
            }
          } catch { /* 向量查询失败静默降级 */ }
        }
      }
      return out.slice(0, limit);
    },
    absorbCount(sessionId) {
      return (absorbCountStmt.get(sessionId) as any).c;
    },
    async compactSmart(sessionId, summarize) {
      // P3b 修复（触发条件）：原 `workingLimit+4` 与黑洞吸附冲突——吸附后
      // archived=0 恒 ≤ workingLimit，导致 /compact 显式调用也永不触发。
      // 改为固定阈值（保头 3 尾 3 + 余量）：消息足够多即可压缩
      const rows = db.prepare(`SELECT id, role, content FROM messages WHERE session_id=? AND archived=0 ORDER BY id`).all(sessionId) as any[];
      if (rows.length <= 8) return;
      const mid = rows.slice(3, -3);
      const summary = await summarize(mid.map((m: any) => `${m.role}: ${m.content}`).join('\n')).catch(() => '');
      if (summary) {
        // F6 修复：不硬 DELETE——中部消息置 archived（recall 全量仍可检索），
        // 摘要写入第一条中部消息原位（保持时间序），其余中部消息归档
        const midIds = mid.map((m: any) => m.id);
        const [firstId, ...restIds] = midIds;
        if (firstId !== undefined) {
          db.prepare(`UPDATE messages SET content=?, role='system', archived=0 WHERE id=?`)
            .run(`（自动压缩摘要）${summary.slice(0, 500)}`, firstId);
          if (restIds.length) {
            db.prepare(`UPDATE messages SET archived=1 WHERE id IN (${restIds.map(() => '?').join(',')})`).run(...restIds);
          }
        }
      } else {
        const ids = rows.map((r: any) => r.id);
        const keep = [...ids.slice(0, 3), ...ids.slice(-3)];
        const drop = ids.filter(id => !keep.includes(id));
        db.prepare(`UPDATE messages SET archived=1 WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop);
      }
    },
    setTitleIfEmpty(sessionId, title) {
      const row = db.prepare(`SELECT title FROM sessions WHERE id=?`).get(sessionId) as { title: string } | undefined;
      if (row && !row.title.trim()) {
        db.prepare(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`).run(title.trim().slice(0, 50), Date.now(), sessionId);
      }
    },
  };
}
