// tests/wave1/w1-workspace-transaction.test.ts — P0-04：staging 事务接入路径双检
// commit/diff 必须走 lexical + realpath/symlink/junction containment；symlink 祖先逃逸一律 fail closed。
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceTransaction } from '../../src/infrastructure/build/workspaceTransaction.js';

describe('workspace transaction path containment', () => {
  it('commits into a plain workspace target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-tx-'));
    try {
      const transaction = new WorkspaceTransaction({ root });
      const staged = await transaction.stage();
      if (!staged.ok) throw new Error(staged.error.code);
      await mkdir(join(staged.value.stagingDir, 'src'));
      const commit = await transaction.commit(staged.value.stagingDir, join(root, 'proj'));
      expect(commit).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects committing through a symlink or junction ancestor', async context => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-tx-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'wxnodus-tx-outside-'));
    try {
      const linkPath = join(root, 'linked');
      try {
        await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
          context.skip();
          return;
        }
        throw error;
      }

      const transaction = new WorkspaceTransaction({ root });
      const staged = await transaction.stage();
      if (!staged.ok) throw new Error(staged.error.code);

      const commit = await transaction.commit(staged.value.stagingDir, join(linkPath, 'proj'));
      expect(commit).toMatchObject({ ok: false, error: { code: 'BUILD_PATH_UNSAFE_SYMLINK' } });

      const diff = await transaction.diff(join(linkPath, 'proj'));
      expect(diff).toMatchObject({ ok: false, error: { code: 'BUILD_PATH_UNSAFE_SYMLINK' } });
      await transaction.abandon(staged.value.stagingDir);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects diff outside the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-tx-escape-'));
    try {
      const transaction = new WorkspaceTransaction({ root });
      expect(await transaction.diff(join(root, '..', 'escape'))).toMatchObject({
        ok: false,
        error: { code: 'BUILD_PATH_OUTSIDE_WORKSPACE' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
