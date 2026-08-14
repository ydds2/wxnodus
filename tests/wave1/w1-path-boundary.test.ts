// tests/wave1/w1-path-boundary.test.ts — P0-04：workspace 路径边界（lexical + realpath/symlink/junction 双检）
// 只接受 workspace root 内的 root-relative target；absolute/../cross-drive/symlink/junction 一律 fail closed。
import { mkdtemp, mkdir, rm, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexicalContainment, validateWorkspaceTarget } from '../../src/infrastructure/fs/pathBoundary.js';

const OUTSIDE = 'BUILD_PATH_OUTSIDE_WORKSPACE';
const UNSAFE = 'BUILD_PATH_UNSAFE_SYMLINK';

describe('workspace path boundary', () => {
  it('rejects absolute, parent-relative, and cross-drive lexical escapes', () => {
    const root = resolve('C:/workspace-root');
    expect(lexicalContainment(root, resolve('C:/workspace-root/proj'))).toBe(resolve('C:/workspace-root/proj'));
    expect(lexicalContainment(root, resolve('C:/workspace-root/../outside'))).toBeNull();
    expect(lexicalContainment(root, resolve('C:/outside'))).toBeNull();
    expect(lexicalContainment(root, resolve(root))).toBeNull();
    if (sep === '\\') {
      expect(lexicalContainment('C:/root-a', resolve('D:/root-b'))).toBeNull();
    }
  });

  it('accepts a plain nested target inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-boundary-'));
    try {
      await mkdir(join(root, 'nested'), { recursive: true });
      const result = await validateWorkspaceTarget(root, join(root, 'nested', 'proj'));
      expect(result).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a target whose existing ancestor is a physical symlink or junction', async context => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-boundary-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'wxnodus-boundary-outside-'));
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

      const result = await validateWorkspaceTarget(root, join(linkPath, 'proj'));
      expect(result).toMatchObject({ ok: false, code: UNSAFE });
      const escape = await validateWorkspaceTarget(root, join(root, 'missing-parent', 'proj'));
      expect(escape).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a pre-existing symlink at the target itself even when its real path is inside the workspace', async context => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-boundary-target-'));
    try {
      const realTarget = join(root, 'real');
      const linkTarget = join(root, 'alias');
      await mkdir(realTarget);
      try {
        await symlink(realTarget, linkTarget, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
          context.skip();
          return;
        }
        throw error;
      }

      expect(await validateWorkspaceTarget(root, linkTarget)).toMatchObject({ ok: false, code: UNSAFE });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a target escaping through a swapped symlink ancestor after validation', async context => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-boundary-swap-'));
    const outside = await mkdtemp(join(tmpdir(), 'wxnodus-boundary-swap-out-'));
    try {
      const parent = join(root, 'parent');
      await mkdir(parent);
      const marker = join(outside, 'marker.txt');
      await writeFile(marker, 'outside');
      const first = await validateWorkspaceTarget(root, join(parent, 'proj'));
      expect(first).toMatchObject({ ok: true });
      try {
        await rename(parent, join(outside, 'stolen-parent'));
        await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
          context.skip();
          return;
        }
        throw error;
      }

      const second = await validateWorkspaceTarget(root, join(parent, 'proj'));
      expect(second).toMatchObject({ ok: false, code: UNSAFE });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
