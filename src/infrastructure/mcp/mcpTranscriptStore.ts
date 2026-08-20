// src/infrastructure/mcp/mcpTranscriptStore.ts — MCP 请求/响应 transcript：redacted 持久记录 + evidence ID
export interface McpTranscriptRecord { requestId: string; direction: 'in'|'out'; method: string;
  status: 'ok'|'denied'|'cancelled'|'error'; redactedPayload: unknown; evidenceId: string; timestamp: string }

const redact = (value: unknown, key = ''): unknown => /token|secret|password|authorization/i.test(key) ? '[REDACTED]' :
  Array.isArray(value) ? value.map(x => redact(x)) : typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redact(v, k)])) : value;

export class InMemoryMcpTranscriptStore {
  private readonly values: McpTranscriptRecord[] = [];
  constructor(private readonly clock: () => string) {}
  append(input: Omit<McpTranscriptRecord,'timestamp'|'redactedPayload'> & { payload: unknown }): void {
    this.values.push({ ...input, timestamp: this.clock(), redactedPayload: redact(input.payload) });
  }
  records(): readonly McpTranscriptRecord[] { return structuredClone(this.values); }
}
