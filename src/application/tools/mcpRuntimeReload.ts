// src/application/tools/mcpRuntimeReload.ts — MCP 客户端候选先同步、提交后再释放旧资源
import type { McpClient } from '../../kernel/mcp.js';

export interface McpRuntimeReloadInput {
  current: readonly McpClient[];
  connect(): Promise<McpClient[]>;
  synchronize(clients: readonly McpClient[]): void;
  publish(clients: McpClient[]): void;
}

export interface McpRuntimeReloadResult {
  clients: McpClient[];
  cleanupFailures: number;
  /** A newer reload superseded this call before it could commit. */
  stale?: true;
}

export class McpRuntimeReloadError extends Error {
  readonly code = 'MCP_RUNTIME_CANDIDATE_DISCONNECTED' as const;

  constructor(readonly servers: string[]) {
    super(`MCP 重载候选未连接：${servers.join(', ')}`);
    this.name = 'McpRuntimeReloadError';
  }
}

interface ReloadGenerationState {
  requested: number;
  published?: McpClient[];
}

const generations = new WeakMap<readonly McpClient[], ReloadGenerationState>();

function generationState(current: readonly McpClient[]): ReloadGenerationState {
  const existing = generations.get(current);
  if (existing) return existing;
  const created: ReloadGenerationState = { requested: 0 };
  generations.set(current, created);
  return created;
}

async function closeClients(clients: readonly McpClient[]): Promise<number> {
  const results = await Promise.allSettled(clients.map(client => Promise.resolve().then(() => client.close())));
  return results.filter(result => result.status === 'rejected').length;
}

/** 提交点是 publish：较新代际优先；此前失败关闭候选并保留旧快照。 */
export async function reloadMcpRuntime(input: McpRuntimeReloadInput): Promise<McpRuntimeReloadResult> {
  const state = generationState(input.current);
  const generation = ++state.requested;
  const candidates = await input.connect();

  if (generation !== state.requested) {
    const cleanupFailures = await closeClients(candidates);
    return { clients: state.published ?? [...input.current], cleanupFailures, stale: true };
  }

  const disconnected = candidates.filter(client => !client.connected).map(client => client.server.name);
  if (disconnected.length > 0) {
    await closeClients(candidates);
    throw new McpRuntimeReloadError(disconnected);
  }

  try {
    input.synchronize(candidates);
    if (generation !== state.requested) {
      const cleanupFailures = await closeClients(candidates);
      return { clients: state.published ?? [...input.current], cleanupFailures, stale: true };
    }
    input.publish(candidates);
    state.published = candidates;
    generations.set(candidates, state);
  } catch (cause) {
    await closeClients(candidates);
    throw cause;
  }
  return { clients: candidates, cleanupFailures: await closeClients(input.current) };
}
