// src/infrastructure/build/workspaceTransaction.ts — staging 事务：安全子目录 + 原子换入（路径逃逸/失败回滚 fail closed）
import { mkdtemp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';

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

  private withinRoot(target: string): string | null {
    const root = resolve(this.options.root);
    const resolved = resolve(target);
    const rel = relative(root, resolved);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return resolved;
  }

  stage(): Promise<OperationResult<{ stagingDir: string }>> {
    return mkdtemp(join(tmpdir(), 'wxnodus-build-'))
      .then(stagingDir => ({ ok: true as const, value: { stagingDir } }))
      .catch(() => fail('BUILD_STAGING_COMMIT_FAILED'));
  }

  async commit(stagingDir: string, targetDir: string): Promise<OperationResult<void>> {
    const target = this.withinRoot(targetDir);
    if (!target) return fail('BUILD_PATH_OUTSIDE_WORKSPACE', { stagingDir, targetDir });
    try {
      await mkdir(dirname(target), { recursive: true });
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
    const target = this.withinRoot(targetDir);
    if (!target) return fail('BUILD_PATH_OUTSIDE_WORKSPACE', { targetDir });
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
