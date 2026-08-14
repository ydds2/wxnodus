// src/infrastructure/fs/pathBoundary.ts — P0-04：workspace 路径边界（lexical + realpath/symlink/junction 双检）
// 请求只接受 workspace root 内的 root-relative target；每个已存在组件都不得是 symlink/junction，
// 且其 realpath 必须仍在 workspace root realpath 内。逃逸/交换/别名一律 fail closed。
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type PathBoundaryErrorCode = 'BUILD_PATH_OUTSIDE_WORKSPACE' | 'BUILD_PATH_UNSAFE_SYMLINK';

export type PathBoundaryResult =
  | { ok: true; target: string }
  | { ok: false; code: PathBoundaryErrorCode };

/** 纯 lexical 包含：resolve 后 target 必须严格位于 root 内部（不允许等于 root）。 */
export function lexicalContainment(root: string, target: string): string | null {
  const base = resolve(root);
  const resolved = resolve(target);
  const rel = relative(base, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return resolved;
}

/** realpath/symlink/junction 双检：每个已存在组件非 symlink 且 realpath 仍被 root realpath 包含。 */
export async function validateWorkspaceTarget(root: string, target: string): Promise<PathBoundaryResult> {
  const lexical = lexicalContainment(root, target);
  if (!lexical) return { ok: false, code: 'BUILD_PATH_OUTSIDE_WORKSPACE' };

  const rootReal = await realpath(resolve(root)).catch(() => null);
  if (!rootReal) return { ok: false, code: 'BUILD_PATH_UNSAFE_SYMLINK' };

  // 定位最深的已存在组件（target 本身或最近祖先）
  let node = lexical;
  for (;;) {
    const stat = await lstat(node).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (stat) break;
    const parent = dirname(node);
    if (parent === node || lexicalContainment(root, parent) === null) return { ok: true, target: lexical };
    node = parent;
  }

  // 逐级验证已存在组件：非 symlink 且 realpath 包含在 root realpath 内
  let current = node;
  for (;;) {
    const stat = await lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return { ok: false, code: 'BUILD_PATH_UNSAFE_SYMLINK' };
    const real = await realpath(current).catch(() => null);
    if (!real || lexicalContainment(rootReal, resolve(real)) === null && resolve(real) !== resolve(rootReal)) {
      return { ok: false, code: 'BUILD_PATH_UNSAFE_SYMLINK' };
    }
    const parent = dirname(current);
    if (lexicalContainment(root, parent) === null) break;
    current = parent;
  }
  return { ok: true, target: lexical };
}
