// src/kernel/sessionStream.ts — 会话事件流（架构 P3：Claude Code 可重放会话对齐）
// 每个会话一个 JSONL 事件流文件（data/session-streams/<id>.jsonl）——用户消息/模型回复/
// 工具执行/审批裁决/压缩时间线完整落盘：审计友好、可重放、可导出分享（含脱敏选项）。
// 写入失败静默（事件流是增强，不阻断主流程）；渐进式——messages 表仍是查询主源。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type SessionEvent =
  | { type: 'user'; content: string; ts: number }
  | { type: 'model'; role: 'text' | 'tool_call'; content?: string; toolCalls?: Array<{ name: string; args: string }>; ts: number }
  | { type: 'tool'; name: string; phase: 'start' | 'complete'; ok?: boolean; ms?: number; ts: number }
  | { type: 'approval'; tool: string; verdict: string; ts: number }
  | { type: 'compact'; summary: string; before: number; after: number; ts: number }
  | { type: 'end'; ok: boolean; turns: number; ts: number }
  | { type: 'stage'; stage: string; ts: number };

function streamDir(dataDir: string): string {
  return join(dataDir, 'session-streams');
}

function streamFile(dataDir: string, sessionId: string): string {
  const safe = String(sessionId ?? 'default').replace(/[^\w-]/g, '_').slice(0, 64);
  return join(streamDir(dataDir), `${safe}.jsonl`);
}

/** 追加会话事件（失败静默——事件流增强不阻断主流程） */
export function appendSessionEvent(dataDir: string, sessionId: string, ev: SessionEvent): void {
  try {
    const f = streamFile(dataDir, sessionId);
    mkdirSync(streamDir(dataDir), { recursive: true });
    appendFileSync(f, JSON.stringify(ev) + '\n', 'utf8');
  } catch { /* 静默 */ }
}

/** 读取会话事件流（按时间序；文件缺失返回空数组） */
export function readSessionEvents(dataDir: string, sessionId: string): SessionEvent[] {
  try {
    const f = streamFile(dataDir, sessionId);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) as SessionEvent; } catch { return null; } })
      .filter((e): e is SessionEvent => e !== null);
  } catch {
    return [];
  }
}

/** 全部会话流文件（/session-stream list 用） */
export function listSessionStreams(dataDir: string): Array<{ sessionId: string; events: number; size: number }> {
  try {
    const dir = streamDir(dataDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const p = join(dir, f);
        const events = readSessionEvents(dataDir, f.slice(0, -6)).length;
        let size = 0;
        try { size = existsSync(p) ? readFileSync(p).length : 0; } catch { /* 忽略 */ }
        return { sessionId: f.slice(0, -6), events, size };
      })
      .sort((a, b) => b.events - a.events);
  } catch {
    return [];
  }
}
