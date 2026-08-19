// src/presentation/tui/tuiPresentationAdapter.ts — W3 TUI facade：presentation adapter 端口 + 组合根工厂
// 计划原文 W3-10：TUI 不直接访问 DB/agent/memory——GatewayClient/React 只经此窄端口读取数据、
// 驱动 agent；原始 db/agent 句柄的持有权留在组合根（CLI），由本工厂在组合根处一次性包裹。
// 语义与迁移前逐点对齐（失败降级行为原样保留：list→[]、get→undefined 等——不改变既有 UX 契约）。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { saveCheckpoint, replaceSessionMessages } from '../../store/db.js';
import { costSummary } from '../../kernel/cost.js';
import { usageSummary } from '../../kernel/usage.js';
import { sessionCost } from '../../kernel/costQuery.js';
import { resolveApiKey } from '../../kernel/providers.js';

export interface TuiMessageRow {
  id: number; role: string; content: string; tool_call_id: string | null; archived: number; ts: number;
}
export interface TuiSessionRow {
  id: string; title: string; created_at: number; updated_at: number; message_count: number;
  /** 每会话成本估算（USD；全部模型有定价才给——未知省略，诚实不显示低估合计） */
  cost_usd?: number;
}
export interface TuiCheckpointRow { id: number; data: string; ts: number }
export interface TuiCronRow { id: number; schedule: string; action: string; enabled: number; last_run: number | null }
/** P1 工作台：体检行（label/value + 语义 tone——status/doctor 工作台结构化数据） */
export interface TuiDoctorRow { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }

export interface TuiAgentPort {
  run(prompt: string, opts?: { images?: Array<{ dataUrl: string; mime: string }> }): Promise<{ ok: boolean; text: string; turns: number; interrupted: boolean }>;
  abort(): void;
  steer(text: string): boolean;
  setSessionId(id: string): void;
  setMode(m: string): void;
  setCwd(path: string): void;
  updateTools(extra: Record<string, unknown>): void;
  setDelegationPaused(paused: boolean): void;
  getDelegationPaused(): boolean;
  getMaxSpawnDepth(): number;
}

export interface TuiDataPort {
  sessions: {
    list(limit: number): TuiSessionRow[];
    create(id: string): void;
    touch(id: string, now: number): void;
    rename(id: string, title: string): void;
    exists(id: string): boolean;
    /** 级联删（messages/checkpoints/sessions）；不存在返回 false */
    delete(id: string): boolean;
    mostRecent(): { id: string; title: string; created_at: number } | undefined;
    /** 分支：源不存在/失败返回 false */
    branch(src: string, newId: string, title: string): boolean;
    /** W3 Session：真实 session 生命周期——组合根注入 sessionStartService.ensure（无端口则兼容通过） */
    ensure(sessionId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  };
  messages: {
    load(sessionId: string): Array<{ role: 'assistant' | 'system' | 'tool' | 'user'; text: string }>;
    nonSystem(sessionId: string): Array<{ id: number; role: string }>;
    rows(sessionId: string): TuiMessageRow[];
    archive(ids: number[]): void;
    replace(sessionId: string, rows: unknown[]): void;
    count(sessionId: string): number;
  };
  checkpoints: {
    save(sessionId: string, payload: { kind: string; messages: unknown[]; ts: number }): number;
    list(sessionId: string, limit: number): TuiCheckpointRow[];
    get(id: number, sessionId: string): TuiCheckpointRow | undefined;
  };
  tasks: {
    insert(id: string, goal: string): void;
    markDone(id: string, output: string): void;
    markAllRunningDone(): number;
    hasRunningOrQueued(sessionId: string): boolean;
  };
  cron: { list(): TuiCronRow[] };
  /** P1 工作台：体检项（真实检测——db 完整性/记忆层/FTS/密钥解密/当前模型） */
  doctor(): TuiDoctorRow[];
  usage: {
    get(sessionId: string): { calls: number; input: number; output: number; cost_usd?: number } | undefined;
    compressions(sessionId: string): number;
    /** 分区间跨会话 token 聚合（状态栏 📊 数据源；unmeasured=端点未上报用量的调用数） */
    usageRange(range: string): { input: number; output: number; total: number; calls: number; unmeasured: number };
  };
}

export interface TuiPresentationAdapter {
  agent: TuiAgentPort;
  data: TuiDataPort;
}

export interface TuiAdapterKernel {
  db: { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number } } };
  agent: TuiAgentPort;
  /** 成本估算价目覆盖（settings.costPrices——自定义中转定价）；可选（缺省按公开参考价目） */
  settings?: Record<string, any>;
  /** P1 工作台：dataDir（doctor 探测 settings.json 存在性）；可选（缺省诚实标注未探测） */
  dataDir?: string;
  /** W3 Session：会话启动工件服务（组合根注入 sessionStartService.ensure——真实 session 生命周期） */
  ensureSession?(sessionId: string): Promise<{ ok: true } | { ok: false; code: string }>;
}

/** 组合根工厂：CLI 持原始句柄，此处包裹为 presentation 窄端口（原始句柄不再进入 UI 层） */
export function createTuiPresentationAdapter(kernel: TuiAdapterKernel): TuiPresentationAdapter {
  const { db, agent } = kernel;
  const costOverrides = kernel.settings?.costPrices as Record<string, { in: number; out: number } | 'free'> | undefined;
  return {
    agent,
    data: {
      sessions: {
        list(limit) {
          try {
            const rows = db.prepare(
              `SELECT s.id, s.title, s.created_at, s.updated_at,
                      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
               FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`,
            ).all(limit) as TuiSessionRow[];
            // 每会话成本估算（N+1 有界：≤50 行才逐会话聚合；全部模型有定价才给——诚实）
            if (rows.length <= 50) {
              return rows.map(r => {
                let cost_usd: number | undefined;
                try {
                  // 单一事实源：costQuery.sessionCost（与 /cost 同 SQL 口径，排除 0 token 行）
                  const q = sessionCost(db, r.id, costOverrides);
                  cost_usd = q && q.unknown === 0 ? Number(q.usd.toFixed(4)) : undefined;
                } catch { /* 成本聚合失败省略该会话 */ }
                return { ...r, cost_usd };
              });
            }
            return rows;
          } catch { return []; }
        },
        create(id) {
          const now = Date.now();
          db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`).run(id, '', now, now);
        },
        touch(id, now) {
          try { db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, id); } catch { /* 忽略 */ }
        },
        rename(id, title) {
          try { db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id); } catch { /* 忽略 */ }
        },
        exists(id) {
          try { return Boolean(db.prepare(`SELECT id FROM sessions WHERE id=?`).get(id)); } catch { return false; }
        },
        delete(id) {
          try {
            const row = db.prepare(`SELECT id FROM sessions WHERE id=?`).get(id);
            if (!row) return false;
            db.prepare(`DELETE FROM messages WHERE session_id=?`).run(id);
            db.prepare(`DELETE FROM checkpoints WHERE session_id=?`).run(id);
            db.prepare(`DELETE FROM sessions WHERE id=?`).run(id);
            return true;
          } catch { return false; }
        },
        mostRecent() {
          try {
            const row = db.prepare(`SELECT id, title, created_at FROM sessions ORDER BY updated_at DESC LIMIT 1`).get() as
              { id: string; title: string; created_at: number } | undefined;
            return row;
          } catch { return undefined; }
        },
        branch(src, newId, title) {
          try {
            const row = db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id=?`).get(src) as { c: number } | undefined;
            if (!row?.c) return false;
            db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
              .run(newId, title, Date.now(), Date.now());
            db.prepare(`
              INSERT INTO messages (session_id, role, content, tool_call_id, archived, ts)
              SELECT ?, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=?
            `).run(newId, src);
            return true;
          } catch { return false; }
        },
        ensure(sessionId) {
          if (!kernel.ensureSession) return Promise.resolve({ ok: true as const });
          return kernel.ensureSession(sessionId).catch(() => ({ ok: false as const, code: 'SESSION_ARTIFACT_FAILED' }));
        },
      },
      messages: {
        load(sessionId) {
          try {
            const rows = db.prepare(
              `SELECT role, content FROM messages WHERE session_id = ? AND archived=0 ORDER BY id`,
            ).all(sessionId) as Array<{ role: string; content: string }>;
            return rows
              .filter(r => r.role === 'user' || r.role === 'assistant')
              .map(r => ({ role: r.role as 'user' | 'assistant', text: r.content }));
          } catch { return []; }
        },
        nonSystem(sessionId) {
          return db.prepare(
            `SELECT id, role FROM messages WHERE session_id=? AND role!='system' AND archived=0 ORDER BY id`,
          ).all(sessionId) as Array<{ id: number; role: string }>;
        },
        rows(sessionId) {
          return db.prepare(
            `SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? AND role!='system' ORDER BY id`,
          ).all(sessionId) as TuiMessageRow[];
        },
        archive(ids) {
          if (!ids.length) return;
          db.prepare(`UPDATE messages SET archived=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        },
        replace(sessionId, rows) {
          replaceSessionMessages(db as never, sessionId, rows as never);
        },
        count(sessionId) {
          return (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`).get(sessionId) as { c: number }).c;
        },
      },
      checkpoints: {
        save(sessionId, payload) {
          try { return saveCheckpoint(db as never, sessionId, payload); } catch { return 0; }
        },
        list(sessionId, limit) {
          try {
            return db.prepare(
              `SELECT id, data, ts FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT ?`,
            ).all(sessionId, limit) as TuiCheckpointRow[];
          } catch { return []; }
        },
        get(id, sessionId) {
          try {
            return db.prepare(`SELECT data, id, ts FROM checkpoints WHERE id=? AND session_id=?`).get(id, sessionId) as
              TuiCheckpointRow | undefined;
          } catch { return undefined; }
        },
      },
      tasks: {
        insert(id, goal) {
          try { db.prepare(`INSERT INTO tasks (id, goal, status, created_at) VALUES (?,?,?,?)`).run(id, goal, 'running', Date.now()); } catch { /* 忽略 */ }
        },
        markDone(id, output) {
          try { db.prepare(`UPDATE tasks SET status='done', output=?, done_at=? WHERE id=?`).run(output, Date.now(), id); } catch { /* 忽略 */ }
        },
        markAllRunningDone() {
          try { return db.prepare(`UPDATE tasks SET status='done', done_at=? WHERE status='running'`).run(Date.now()).changes; } catch { return 0; }
        },
        hasRunningOrQueued(sessionId) {
          try {
            const row = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE parent_id = ? AND status IN ('running','queued')`)
              .get(sessionId) as { c: number } | undefined;
            return Number(row?.c ?? 0) > 0;
          } catch { return false; }
        },
      },
      cron: {
        list() {
          try {
            return db.prepare(`SELECT id, schedule, action, enabled, last_run FROM cron_jobs ORDER BY id`).all() as TuiCronRow[];
          } catch { return []; }
        },
      },
      // P1 工作台：体检真实检测（与内核 /doctor 同源检查项——db 完整性/记忆层/FTS/密钥解密/当前模型）
      doctor() {
        const rows: TuiDoctorRow[] = []
        try {
          if (kernel.dataDir) {
            const exists = existsSync(join(kernel.dataDir, 'settings.json'))
            rows.push({ label: '配置中心', value: exists ? '正常' : '未初始化', tone: exists ? 'ok' : 'warn' })
          } else {
            rows.push({ label: '配置中心', value: '未探测（无 dataDir 端口）', tone: 'muted' })
          }
        } catch { rows.push({ label: '配置中心', value: '异常（路径不可读）', tone: 'bad' }) }
        try {
          const r = db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string } | undefined
          const ok = r?.integrity_check === 'ok'
          rows.push({ label: '数据库', value: ok ? '正常' : `异常（${r?.integrity_check ?? '未知'}）`, tone: ok ? 'ok' : 'bad' })
        } catch { rows.push({ label: '数据库', value: '异常（无法执行完整性检查）', tone: 'bad' }) }
        try {
          const total = (db.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number }).c
          const archived = (db.prepare(`SELECT COUNT(*) c FROM messages WHERE archived=1`).get() as { c: number }).c
          rows.push({ label: '黑洞记忆', value: `${total} 条（其中 ${archived} 条已归档压缩，仍可检索）`, tone: 'ok' })
        } catch { rows.push({ label: '黑洞记忆', value: '异常（表不可读）', tone: 'bad' }) }
        try {
          const fts = (db.prepare(`SELECT COUNT(*) c FROM messages_fts`).get() as { c: number }).c
          rows.push({ label: '全文索引', value: `${fts} 条可检索`, tone: fts > 0 ? 'ok' : 'muted' })
        } catch { rows.push({ label: '全文索引', value: '未初始化', tone: 'muted' }) }
        const settings = (kernel.settings ?? {}) as Record<string, any>
        try {
          const keyRes = resolveApiKey(settings)
          if (keyRes.key) rows.push({ label: '模型密钥', value: `已配置且可解密（provider=${keyRes.provider}）`, tone: 'ok' })
          else if (keyRes.error === 'provider-mismatch') rows.push({ label: '模型密钥', value: `provider 不符：${keyRes.hint}`, tone: 'bad' })
          else if (keyRes.source === 'enc') rows.push({ label: '模型密钥', value: '已配置但无法解密（需 /model set-key 重配）', tone: 'bad' })
          else rows.push({ label: '模型密钥', value: '未配置（/model set-key <密钥> 配置）', tone: 'muted' })
        } catch { rows.push({ label: '模型密钥', value: '状态不可读', tone: 'muted' }) }
        const model = String(settings.model ?? '')
        rows.push({ label: '当前模型', value: model || '未选择', tone: model ? 'ok' : 'muted' })
        return rows
      },
      usage: {
        get(sessionId) {
          try {
            const row = db.prepare(
              `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
               FROM usage_stats WHERE session_id=?`,
            ).get(sessionId) as { calls: number; input: number; output: number } | undefined;
            if (!row) return undefined;
            // 状态栏 $ 成本段数据源（#11 尾项）：按模型聚合估算——全部模型有定价才给
            // cost_usd（部分未知则省略——诚实：绝不显示被低估的合计）；空会话（calls=0）不给（无噪音 $0）
            if (!row.calls) return row;
            try {
              const modelRows = db.prepare(
                `SELECT model, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
                 FROM usage_stats WHERE session_id=? GROUP BY model`,
              ).all(sessionId) as Array<{ model: string; input: number; output: number }>;
              const s = costSummary(modelRows, costOverrides);
              return s.unknownCount === 0 ? { ...row, cost_usd: Number(s.totalUsd.toFixed(6)) } : row;
            } catch { return row; }
          } catch { return undefined; }
        },
        compressions(sessionId) {
          try {
            const c = db.prepare(
              `SELECT COUNT(*) AS c FROM messages WHERE session_id=? AND content LIKE '（自动压缩摘要）%'`,
            ).get(sessionId) as { c: number } | undefined;
            return c?.c ?? 0;
          } catch { return 0; }
        },
        usageRange(range) {
          try {
            // 单一事实源：kernel/usage usageSummary（与 /usage 同 SQL 口径；unmeasured 透传状态栏）
            const s = usageSummary(db, (range === 'today' || range === '7d' || range === '30d') ? range : 'today');
            return { input: s.input, output: s.output, total: s.total, calls: s.calls, unmeasured: s.unmeasured };
          } catch { return { input: 0, output: 0, total: 0, calls: 0, unmeasured: 0 }; }
        },
      },
    },
  };
}
