// src/infrastructure/build/workspaceTransaction.ts — staging 事务：安全子目录 + 原子换入（路径逃逸/失败回滚 fail closed）
// P0-04：路径校验走 pathBoundary（lexical + realpath/symlink/junction 双检），不再只做 lexical 比较。
import { mkdtemp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import { validateWorkspaceTarget } from '../fs/pathBoundary.js';

const fail = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface WorkspaceTransactionOptions {
  /** 工作区根：staging 目标路径必须落在其中，否则 BUILD_PATH_OUTSIDE_WORKSPACE */
  root: string;
}

export class WorkspaceTransaction {
  constructor(private readonly options: WorkspaceTransactionOptions) {}

  private async safeTarget(target: string): Promise<{ ok: true; target: string } | { ok: false; code: string }> {
    return validateWorkspaceTarget(this.options.root, target);
  }

  stage(): Promise<OperationResult<{ stagingDir: string }>> {
    return mkdtemp(join(tmpdir(), 'wxnodus-build-'))
      .then(stagingDir => ({ ok: true as const, value: { stagingDir } }))
      .catch(() => fail('BUILD_STAGING_COMMIT_FAILED'));
  }

  async commit(stagingDir: string, targetDir: string): Promise<OperationResult<void>> {
    const boundary = await this.safeTarget(targetDir);
    if (!boundary.ok) return fail(boundary.code, { stagingDir, targetDir });
    const target = boundary.target;
    try {
      await mkdir(dirname(target), { recursive: true });
      // mkdir 后再校验一次：创建过程不得经过 symlink/junction 祖先
      const rechecked = await this.safeTarget(targetDir);
      if (!rechecked.ok) return fail(rechecked.code, { stagingDir, targetDir });
      const backup = `${target}.bak-${Date.now().toString(36)}`;
      let movedOld = false;
      try { await rename(target, backup); movedOld = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await rename(stagingDir, target);
      } catch (commitError) {
        if (movedOld) await rename(backup, target).catch(() => undefined);
        throw commitError;
      }
      if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return { ok: true, value: undefined };
    } catch {
      return fail('BUILD_STAGING_COMMIT_FAILED', { targetDir });
    }
  }

  async abandon(stagingDir: string): Promise<void> {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async diff(targetDir: string): Promise<OperationResult<{ changed: string[] }>> {
    const boundary = await this.safeTarget(targetDir);
    if (!boundary.ok) return fail(boundary.code, { targetDir });
    const target = boundary.target;
    try {
      const changed: string[] = [];
      const walk = async (dir: string, prefix = '') => {
        for (const name of await readdir(dir, { withFileTypes: true })) {
          if (name.isDirectory()) await walk(join(dir, name.name), prefix ? `${prefix}/${name.name}` : name.name);
          else if (!name.name.startsWith('.') && name.name !== 'evidence.json') changed.push(prefix ? `${prefix}/${name.name}` : name.name);
        }
      };
      await walk(target);
      return { ok: true, value: { changed } };
    } catch {
      return { ok: true, value: { changed: [] } };
    }
  }
}
