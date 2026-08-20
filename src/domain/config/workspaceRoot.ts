// src/domain/config/workspaceRoot.ts — W7-00：主工作区动态指定（用户动态确定的项目文件夹）
// 优先级：cli(--workspace) > env(WXNODUS_WORKSPACE) > persisted(settings.workspace) > cwd（默认项目文件夹）。
// 显式给出但非法的值 fail-closed（绝不静默降级到低优先级来源——用户指定了就要尊重或报错）。
import { existsSync, realpathSync, statSync } from 'node:fs';
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

/** 候选必须是存在的绝对目录，并在进入组合根前解析为真实规范路径。 */
function checkCandidate(value: unknown, source: WorkspaceSource, optional: boolean): OperationResult<ResolvedWorkspace> | null {
  if (value === undefined || value === null || String(value).trim() === '') {
    return optional ? null : { ok: false, error: configError('WORKSPACE_INVALID', 'workspace.root.invalid', { source, reason: '工作区不能为空' }) };
  }
  const raw = String(value);
  if (!isAbsolute(raw)) {
    return { ok: false, error: configError('WORKSPACE_INVALID', 'workspace.root.invalid', { source, value: raw, reason: '必须是绝对路径' }) };
  }
  if (!existsSync(raw)) {
    return { ok: false, error: configError('WORKSPACE_NOT_FOUND', 'workspace.root.notFound', { source, value: raw, reason: '目录不存在（先创建目录或用 /workspace set --create）' }) };
  }
  try {
    if (!statSync(raw).isDirectory()) {
      return { ok: false, error: configError('WORKSPACE_NOT_DIRECTORY', 'workspace.root.notDirectory', { source, value: raw, reason: '路径不是目录' }) };
    }
    return { ok: true, value: { value: realpathSync.native(raw), source } };
  } catch (cause) {
    return { ok: false, error: configError('WORKSPACE_INVALID', 'workspace.root.invalid', { source, value: raw, reason: String((cause as Error).message ?? cause) }) };
  }
}

export function resolveWorkspaceRoot(input: WorkspaceCandidates): OperationResult<ResolvedWorkspace> {
  const ordered: Array<[WorkspaceSource, unknown]> = [
    ['cli', input.cli], ['env', input.env], ['persisted', input.persisted],
  ];
  for (const [source, candidate] of ordered) {
    const checked = checkCandidate(candidate, source, true);
    if (checked) return checked; // 合法或非法都终止——显式值不静默降级
  }
  return checkCandidate(input.cwd, 'cwd', false)!;
}
