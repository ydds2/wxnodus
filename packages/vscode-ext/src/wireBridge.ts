// packages/vscode-ext/src/wireBridge.ts — --wire 事件流桥接纯函数（supremacy 2.1）
// 协议契约：docs/wire-protocol.md v1（2026-08-18 修订版）。
// 本模块零 vscode 依赖（node:test 可测）——extension.ts 只做装配与 UI。
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** 事件行（wire 流每行一个 JSON，未知字段容错忽略） */
export interface WireEvent {
  type: string;
  [k: string]: unknown;
}

/** 请求帧（stdin → stdout wire.response） */
export interface WireFrame {
  method: string;
  params: Record<string, unknown>;
}

/** 解析一行 JSONL → WireEvent（非 JSON/无 type → null——协议：非 JSON 行忽略） */
export function parseWireLine(line: string): WireEvent | null {
  const s = String(line ?? '').trim();
  if (!s) return null;
  let j: unknown;
  try { j = JSON.parse(s); } catch { return null; }
  if (typeof j !== 'object' || j === null) return null;
  const ev = j as WireEvent;
  if (typeof ev.type !== 'string' || !ev.type) return null;
  return ev;
}

/** 请求帧序列化（每行一个 JSON） */
export function encodeWireFrame(frame: WireFrame): string {
  return JSON.stringify(frame) + '\n';
}

/** approval.request → 模态展示载荷（tool/args 摘要） */
export function approvalModalText(ev: WireEvent): { title: string; detail: string } {
  const tool = String(ev.tool ?? '未知工具');
  let detail = '';
  try { detail = JSON.stringify(ev.args ?? {}, null, 2).slice(0, 500); } catch { detail = String(ev.args ?? ''); }
  return { title: `审批请求：${tool}`, detail };
}

/** 审批应答帧（allow/session/deny） */
export function approvalAnswer(requestId: string, answer: 'allow' | 'session' | 'deny'): WireFrame {
  return { method: 'approval.respond', params: { request_id: requestId, answer } };
}

/** clarify/secret/form 应答帧 */
export function textAnswer(method: 'clarify.respond' | 'secret.respond', requestId: string, value: string): WireFrame {
  return { method, params: { request_id: requestId, ...(method === 'secret.respond' ? { value } : { answer: value }) } };
}

/** 终态行检测：agent.result 恒为最后一行（消费方据此收尾） */
export function isTerminalEvent(ev: WireEvent): boolean {
  return ev.type === 'agent.result';
}

export type WireChild = ChildProcessWithoutNullStreams;
