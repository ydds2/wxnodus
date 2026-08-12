// src/kernel/memory.ts — L2-2 黑洞引擎（百万上下文）
// 设计（MemGPT 思想 + 成熟技术）：
//   三层记忆——working（会话窗口，超压自动吸附）/ archival（FTS5+向量 无限）/ recall（全量永不删）
//   黑洞吸附 absorb：working > limit 时旧消息自动吸入 archival（消息仍在 recall 全量）
//   混合召回 recallHybrid：FTS5 中文 bigram + sqlite-vec KNN，去重合并；embedding 不可用降级纯 FTS
//   压缩 compactKeepHeadTail（确定性保头尾）/ compactSmart（LLM 总结中部，失败降级）
//   参考：MemGPT 分层记忆、Claude Code autocompact、Gemini GEMINI.md JIT
import type { Db } from '../store/db.js';
import { searchMessages } from '../store/db.js';

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

// ── A21：时间过滤解析（/memory search|list --since）────────
// 支持：ISO 日期/时间（2026-08-01 / 2026-08-01T10:00 / 时间戳）与相对（7d/24h/30m/2w）
export function parseSinceArg(raw: string | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const iso = Date.parse(s);
  if (!Number.isNaN(iso)) return iso;
  const m = s.match(/^(\d+)\s*(d|h|m|w)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 604_800_000;
    return now - n * unit;
  }
  return null;
}

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

// ── embedding（transformers.js 本地模型，默认 all-MiniLM-L6-v2 384 维；失败/冷却降级）──
// 开放兼容：WXNODUS_EMBED_MODEL 可换本地模型（如 Xenova/bge-small-zh-v1.5）；
// 输出维度 ≠384（向量表固定维度）时禁用向量索引降级纯 FTS——换模型不崩库。
// WXN_NO_EMBED 保留兼容，WXNODUS_EMBED=off 为新名。
const EMBED_DIM = 384;
let embedder: any = null;
let embedFailTs = 0;
async function embed(text: string): Promise<number[] | null> {
  if (process.env.WXNODUS_EMBED === 'off' || process.env.WXN_NO_EMBED) return null;
  const now = Date.now();
  if (embedFailTs && now - embedFailTs < 10 * 60 * 1000) return null; // 失败冷却 10 分钟
  try {
    if (!embedder) {
      const { pipeline } = await import('@huggingface/transformers');
      const model = process.env.WXNODUS_EMBED_MODEL?.trim() || 'Xenova/all-MiniLM-L6-v2';
      embedder = await pipeline('feature-extraction', model, { dtype: 'q8' });
    }
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data as Float32Array);
    // 维度校验：非 384 维与 archival_vec 表不匹配——禁用向量写入（调用方降级 FTS）
    if (vec.length !== EMBED_DIM) {
      embedFailTs = Date.now();
      return null;
    }
    return vec;
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
  recallHybrid(query: string, opts?: { limit?: number; sessionId?: string; since?: number }): Promise<Array<{ id: number; content: string; score: number; session_id?: string; ts?: number }>>;
  /** 记忆置顶/淡化：salience 倍率（1=默认，>1 置顶加强，<1 淡化） */
  setSalience(messageId: number, mult: number): boolean;
  /** 全部置顶记忆（salience>1，按倍率降序）——/memory list 与召回加权共用 */
  listSalient(): Array<{ id: number; content: string; salience: number; ts: number }>;
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
  // A21：去重比对——仅最近 1 条消息完全相同（≥20 字符）时合并（防"继续/好的"误删、
  // 防交错重复文本误合；连续重复提交才去重，消息序不因跳插断裂）
  const lastMsgStmt = db.prepare(`SELECT id, role, content FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1`);
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
      // A21 写入去重合并：仅与最近 1 条消息相邻且同角色、内容完全相同（≥20 字符）
      // → 跳过插入、刷新原条时间戳（连续重复提交不堆积；交错对话/不同角色不受影响）
      if (role === 'user' || role === 'assistant') {
        const norm = String(content ?? '').trim();
        if (norm.length >= 20) {
          const last = lastMsgStmt.get(sessionId) as { id: number; role: string; content: string } | undefined;
          if (last && last.role === role && String(last.content ?? '').trim() === norm) {
            db.prepare(`UPDATE messages SET ts=? WHERE id=?`).run(Date.now(), last.id);
            return;
          }
        }
      }
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
      // F6 置顶加权：召回分 = FTS 命中分 × salience 倍率——置顶记忆（pin）分数放大，
      // 淡化记忆（fade）自然沉底；相同权重按 FTS rank 顺序稳定
      const fts = searchMessages(db, query, { limit: limit * 2, sessionId: opts.sessionId, since: opts.since })
        .map(r => ({ id: r.id, content: r.content, score: 1 * Math.max(0.05, r.salience ?? 1), session_id: r.session_id, ts: r.ts }));
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
              const row = db.prepare(`SELECT id, content, salience, session_id, ts FROM messages WHERE id=?`).get(k.id) as { id: number; content: string; salience: number; session_id: string; ts: number } | undefined;
              if (!row) continue;
              seen.add(row.id);
              out.push({ id: row.id, content: row.content, score: 0.8 * Math.max(0.05, row.salience ?? 1), session_id: row.session_id, ts: row.ts });
              if (out.length >= limit) break;
            }
          } catch { /* 向量查询失败静默降级 */ }
        }
      }
      // 置顶加权后重排（稳定排序：分数相同保持原序）
      return out
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    setSalience(messageId, mult) {
      const v = Math.min(10, Math.max(0.05, mult));
      const r = db.prepare(`UPDATE messages SET salience=? WHERE id=?`).run(v, messageId);
      return r.changes > 0;
    },
    listSalient() {
      return db.prepare(`SELECT id, content, salience, ts FROM messages WHERE salience > 1.01 ORDER BY salience DESC, ts DESC LIMIT 50`).all() as Array<{ id: number; content: string; salience: number; ts: number }>;
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
