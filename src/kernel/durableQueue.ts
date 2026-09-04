// src/kernel/durableQueue.ts — P2-14（2026-08-27）：用户消息持久队列 + 崩溃恢复
// 机制参考 codex thread-store QueueStore（queue_store.rs:14 用户消息持久队列）+ rollout 重放
// 语义·实现原创：
//   ① 入队先于模型处理——prompt 落盘后才进回合循环（进程崩溃不丢用户消息）；
//   ② 终态收口——任何结局（成功/失败/中断）都标记 done（队列保消息不保结局，
//      结局语义归 RunContext 六终态 + checkpoint 中断回放，不双写第二套结局）；
//   ③ 崩溃恢复——启动时 stale（queued/running 且超时未更新）标记 interrupted，
//      经 system.notice 如实告知（checkpoint 已保留上下文——/rewind 回滚或重新提问）。
import type { AuditDb } from './audit.js';

export type DurablePromptStatus = 'queued' | 'running' | 'done' | 'interrupted';

export interface DurablePromptRow {
  id: number;
  sessionId: string;
  prompt: string;
  status: DurablePromptStatus;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 入队（进模型循环前落盘）——返回队列行 id */
export function enqueueDurablePrompt(db: AuditDb, sessionId: string, prompt: string, runId: string | null): number {
  const ts = Date.now();
  const r = db.prepare(`
    INSERT INTO durable_prompts (session_id, prompt, status, run_id, created_at, updated_at)
    VALUES (?, ?, 'queued', ?, ?, ?)
  `).run(sessionId, prompt, runId, ts, ts);
  return Number(r.lastInsertRowid);
}

export function markDurableRunning(db: AuditDb, id: number): void {
  db.prepare(`UPDATE durable_prompts SET status='running', updated_at=? WHERE id=?`).run(Date.now(), id);
}

export function markDurableDone(db: AuditDb, id: number): void {
  db.prepare(`UPDATE durable_prompts SET status='done', updated_at=? WHERE id=?`).run(Date.now(), id);
}

/** 崩溃恢复：stale 的 queued/running 行 → interrupted（保留原文）——仅返回本次新恢复的行 */
export function recoverStalePrompts(db: AuditDb, sessionId: string, staleMs = 5 * 60_000): DurablePromptRow[] {
  const cutoff = Date.now() - staleMs;
  const rows = db.prepare(`
    UPDATE durable_prompts SET status='interrupted', updated_at=?
    WHERE session_id=? AND status IN ('queued','running') AND updated_at < ?
    RETURNING id, session_id AS sessionId, prompt, status, run_id AS runId, created_at AS createdAt, updated_at AS updatedAt
  `).all(Date.now(), sessionId, cutoff);
  return rows as unknown as DurablePromptRow[];
}

/**
 * N1（批次ⅩⅩⅦ · kernel-eval）孤儿行清扫：终态行（done/interrupted）超期删除——
 * 子代理一次性会话 id 的遗留行（死守卫时期入队）与正常完成行都会累积，7 天足够
 * 任何事后审计（audit 链才是审计事实源——本表只保「未完成用户消息」语义）。
 */
export function purgeDurableRows(db: AuditDb, olderThanMs = 7 * 24 * 60 * 60_000): number {
  const cutoff = Date.now() - olderThanMs;
  const info = db.prepare(`DELETE FROM durable_prompts WHERE status IN ('done','interrupted') AND updated_at < ?`).run(cutoff) as unknown as { changes?: number | bigint };
  return Number(info?.changes ?? 0);
}

/** 未收口计数（doctor/恢复提示用） */
export function pendingDurableCount(db: AuditDb, sessionId: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM durable_prompts WHERE session_id=? AND status IN ('queued','running')`).get(sessionId) as { c: number };
  return Number(r.c);
}


/**
 * ⅩⅩⅪ rollout 重放：stale 行自动重投（codex resume_thread_from_rollout 语义增量）。
 * 与 recoverStalePrompts 的区别：后者只标 interrupted（保原文不自动重发——设计取舍），
 * 本函数额外返回可重投的 prompt 列表（调用方可选择自动发送或展示给用户确认）。
 * 返回的行已标 interrupted（状态语义不变——重投是新回合的 enqueue，不是恢复旧行）。
 */
export function recoverStaleWithReplay(
  db: AuditDb,
  sessionId: string,
  staleMs = 5 * 60_000,
): { recovered: DurablePromptRow[]; replayable: Array<{ prompt: string; ts: number }> } {
  const recovered = recoverStalePrompts(db, sessionId, staleMs);
  return {
    recovered,
    replayable: recovered
      .filter(r => r.prompt.trim().length > 0)
      .map(r => ({ prompt: r.prompt, ts: r.createdAt })),
  };
}
