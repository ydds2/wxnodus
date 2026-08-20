// src/application/release/installerCandidate.ts — DX-04：冻结安装器候选（candidate）
// 打包器只消费冻结 candidate（ID/commit/tgz hash/OS-arch-Node cell/staged tree/entrypoint），
// 绝不再猜 dist/cli。校验失败 fail-closed（INSTALLER_CANDIDATE_*）。
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import { validateInstallerPaths } from './installerPathPolicy.js';

export interface InstallerCell { os: string; arch: string; node: string }
export interface FrozenInstallerCandidate {
  candidateId: string;
  commit: string;
  tgzSha256: string;
  cell: InstallerCell;
  stagedTree: Map<string, Buffer>;
  entrypoint: string;
  /** 显式声明的非字面量动态 import（字面量扫描覆盖不到的运行时拼装说明） */
  dynamicImportDeclarations: string[];
}

const fail = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: configError(code, `installer.candidate.${code.toLowerCase()}`, details),
});

export function validateFrozenInstallerCandidate(candidate: FrozenInstallerCandidate): OperationResult<FrozenInstallerCandidate> {
  if (!candidate.candidateId || !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(candidate.candidateId)) {
    return fail('INSTALLER_CANDIDATE_ID_INVALID', { candidateId: candidate.candidateId });
  }
  if (!/^[0-9a-f]{40}$/.test(candidate.commit)) return fail('INSTALLER_CANDIDATE_COMMIT_INVALID', { commit: candidate.commit });
  if (!/^[0-9a-f]{64}$/.test(candidate.tgzSha256)) return fail('INSTALLER_CANDIDATE_TGZ_INVALID', { tgzSha256: candidate.tgzSha256 });
  const { os, arch, node } = candidate.cell;
  if (!os || !arch || !/^v?\d+\.\d+\.\d+/.test(node)) return fail('INSTALLER_CANDIDATE_CELL_INVALID', { cell: candidate.cell });
  if (!candidate.stagedTree || candidate.stagedTree.size === 0) return fail('INSTALLER_CANDIDATE_TREE_EMPTY');
  const paths = validateInstallerPaths(candidate.stagedTree.keys(), candidate.entrypoint);
  if (!paths.ok) return paths;
  if (!candidate.stagedTree.has(candidate.entrypoint)) {
    return fail('INSTALLER_CANDIDATE_ENTRY_MISSING', { entrypoint: candidate.entrypoint });
  }
  if (!Array.isArray(candidate.dynamicImportDeclarations)) return fail('INSTALLER_CANDIDATE_DYNAMIC_IMPORTS_INVALID');
  return { ok: true, value: candidate };
}
