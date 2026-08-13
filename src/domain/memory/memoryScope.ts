// src/domain/memory/memoryScope.ts — Black Hole Memory 作用域模型：写入显式声明，读取按 opt-in 分层
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';

export interface MemoryScope { sessionId?: string; projectId?: string; userArchive?: boolean; globalOptIn?: boolean }
export type MemoryScopeTier = 'session' | 'project' | 'user_archive' | 'global';
export interface StoredMemoryScope { tier: MemoryScopeTier; key: string }

export const MEMORY_SCOPE_WEIGHT = Object.freeze({ session: 1, project: 0.8, user_archive: 0.6, global: 0.4 } satisfies Record<MemoryScopeTier, number>);

export function resolveWriteScope(scope: MemoryScope) {
  if (scope.sessionId) return ok<StoredMemoryScope>({ tier: 'session', key: scope.sessionId });
  if (scope.projectId) return ok<StoredMemoryScope>({ tier: 'project', key: scope.projectId });
  if (scope.userArchive) return ok<StoredMemoryScope>({ tier: 'user_archive', key: 'user' });
  if (scope.globalOptIn) return ok<StoredMemoryScope>({ tier: 'global', key: 'global' });
  return err(gatewayError('MEMORY_SCOPE_REQUIRED', '写入必须声明 memory scope', 'memory.scope.required'));
}

export function accessibleScopes(scope: MemoryScope): StoredMemoryScope[] {
  const out: StoredMemoryScope[] = [];
  if (scope.sessionId) out.push({ tier: 'session', key: scope.sessionId });
  if (scope.projectId) out.push({ tier: 'project', key: scope.projectId });
  if (scope.userArchive) out.push({ tier: 'user_archive', key: 'user' });
  if (scope.globalOptIn) out.push({ tier: 'global', key: 'global' });
  return out;
}
