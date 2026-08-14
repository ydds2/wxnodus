// src/domain/config/workspaceRoot.ts — W7-00：主工作区动态指定（用户动态确定的项目文件夹）
// 优先级：cli(--workspace) > env(WXNODUS_WORKSPACE) > persisted(settings.workspace) > cwd（默认项目文件夹）。
// 显式给出但非法的值 fail-closed（绝不静默降级到低优先级来源——用户指定了就要尊重或报错）。
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from './configSchema.js';

export type WorkspaceSource = 'cli' | 'env' | 'persisted' | 'cwd';

export interface WorkspaceCandidates {
  cli?: unknown;
  env?: unknown;
  persisted?: unknown;
  cwd: string;
}

export interface ResolvedWorkspace { value: string; source: WorkspaceSource }

/** 显式候选（cli/env/persisted）：null/空串视为未给出；非空则必须合法——非法直接 fail-closed */
function checkExplicit(value: unknown, source: WorkspaceSource): OperationResult<ResolvedWorkspace> | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value);
  if (!isAbsolute(raw)) {
    return { ok: false, error: configError('WORKSPACE_INVALID', 'workspace.root.invalid', { source, value: raw, reason: '必须是绝对路径' }) };
  }
  if (!existsSync(raw)) {
    return { ok: false, error: configError('WORKSPACE_NOT_FOUND', 'workspace.root.notFound', { source, value: raw, reason: '目录不存在（先创建目录或用 /workspace set --create）' }) };
  }
  return { ok: true, value: { value: raw, source } };
}

export function resolveWorkspaceRoot(input: WorkspaceCandidates): OperationResult<ResolvedWorkspace> {
  const ordered: Array<[WorkspaceSource, unknown]> = [
    ['cli', input.cli], ['env', input.env], ['persisted', input.persisted],
  ];
  for (const [source, candidate] of ordered) {
    const checked = checkExplicit(candidate, source);
    if (checked) return checked; // 合法或非法都终止——显式值不静默降级
  }
  return { ok: true, value: { value: input.cwd, source: 'cwd' } };
}
