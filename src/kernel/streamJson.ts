// src/kernel/streamJson.ts — L6-3 差距 #9：stream-json 事件流（CI 门禁友好）
export interface StreamEvent { type: string; payload: Record<string, any> }

export function toStreamJson(events: StreamEvent[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}
