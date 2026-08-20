import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeWorkspaceRead, safeWorkspaceWrite, workspaceSha256 } from '../src/infrastructure/fs/safeWorkspaceFs.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('Windows handle-bound workspace file operations', () => {
  windowsIt('creates and updates a file through verified handles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-safe-positive-'));
    try {
      const target = join(root, 'nested', 'target.txt');
      const created = await safeWorkspaceWrite(root, target, Buffer.from('first'), { mustNotExist: true });
      expect(created).toEqual({ bytes: 5, sha256: workspaceSha256('first') });
      expect((await safeWorkspaceRead(root, target)).toString('utf8')).toBe('first');

      const replaced = await safeWorkspaceWrite(root, target, Buffer.from('second'), { expectedSha256: created.sha256 });
      expect(replaced).toEqual({ bytes: 6, sha256: workspaceSha256('second') });
      expect(await readFile(target, 'utf8')).toBe('second');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  windowsIt('refuses replacement when the opened file no longer matches the expected identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-safe-cas-'));
    try {
      const target = join(root, 'target.txt');
      await writeFile(target, 'changed');
      await expect(safeWorkspaceWrite(root, target, Buffer.from('replacement'), { expectedSha256: workspaceSha256('original') }))
        .rejects.toMatchObject({ code: 'WORKSPACE_FILE_CHANGED' });
      expect(await readFile(target, 'utf8')).toBe('changed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  windowsIt('rejects an ancestor swapped to a junction between preflight and read open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-safe-read-'));
    const outside = await mkdtemp(join(tmpdir(), 'wxnodus-safe-read-out-'));
    try {
      const parent = join(root, 'parent');
      await mkdir(parent);
      await writeFile(join(parent, 'secret.txt'), 'inside');
      await writeFile(join(outside, 'secret.txt'), 'outside');

      await expect(safeWorkspaceRead(root, join(parent, 'secret.txt'), {
        afterPreflight: async () => {
          await rename(parent, join(outside, 'original-parent'));
          await symlink(outside, parent, 'junction');
        },
      })).rejects.toMatchObject({ code: 'BUILD_PATH_UNSAFE_SYMLINK' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  windowsIt('rejects an ancestor swapped to a junction between preflight and write open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-safe-write-'));
    const outside = await mkdtemp(join(tmpdir(), 'wxnodus-safe-write-out-'));
    try {
      const parent = join(root, 'parent');
      await mkdir(parent);
      const outsideTarget = join(outside, 'target.txt');
      await writeFile(outsideTarget, 'outside-before');

      await expect(safeWorkspaceWrite(root, join(parent, 'target.txt'), Buffer.from('inside-write'), {
        afterPreflight: async () => {
          await rename(parent, join(outside, 'original-parent'));
          await symlink(outside, parent, 'junction');
        },
      })).rejects.toMatchObject({ code: 'BUILD_PATH_UNSAFE_SYMLINK' });
      expect(await readFile(outsideTarget, 'utf8')).toBe('outside-before');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  windowsIt('rejects a pre-existing junction and leaves its target unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-safe-junction-'));
    const outside = await mkdtemp(join(tmpdir(), 'wxnodus-safe-junction-out-'));
    try {
      const outsideTarget = join(outside, 'target.txt');
      await writeFile(outsideTarget, 'outside-before');
      await symlink(outside, join(root, 'linked'), 'junction');

      await expect(safeWorkspaceWrite(root, join(root, 'linked', 'target.txt'), Buffer.from('bad')))
        .rejects.toMatchObject({ code: 'BUILD_PATH_UNSAFE_SYMLINK' });
      expect(await readFile(outsideTarget, 'utf8')).toBe('outside-before');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
