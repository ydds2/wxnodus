// src/release/knownFailures.ts — 已知缺陷 machine registry（30-ID 判别联合；修复必须原子迁移）
export type KnownFailureId = `KF-${string}`;

export type KnownFailureEntry =
  | {
      id: KnownFailureId;
      status: 'open';
      caseFile: `tests/known-failures/cases/${string}.case.ts`;
      expectedFailureCode: string;
      timeoutMs: number;
    }
  | {
      id: KnownFailureId;
      status: 'resolved-with-green-regression';
      regressionFile: `tests/regressions/known-failures/${string}.regression.test.ts`;
      resolvedBy: string;
      timeoutMs: number;
    };

export const REQUIRED_KNOWN_FAILURE_IDS = Array.from(
  { length: 30 },
  (_, index) => `KF-${String(index + 1).padStart(3, '0')}`,
) as KnownFailureId[];

export const KNOWN_FAILURES: readonly KnownFailureEntry[] = [
  { id: 'KF-001', status: 'open', caseFile: 'tests/known-failures/cases/kf-001-offline-no-key.case.ts', expectedFailureCode: 'OFFLINE_PROVIDER_KEY_PRECHECK', timeoutMs: 15000 },
  { id: 'KF-002', status: 'open', caseFile: 'tests/known-failures/cases/kf-002-config-full.case.ts', expectedFailureCode: 'CONFIG_FULL_UNREACHABLE', timeoutMs: 15000 },
  { id: 'KF-003', status: 'open', caseFile: 'tests/known-failures/cases/kf-003-setup-wizard.case.ts', expectedFailureCode: 'SETUP_WIZARD_NOT_ENTERED', timeoutMs: 15000 },
  { id: 'KF-004', status: 'open', caseFile: 'tests/known-failures/cases/kf-004-personality-persistence.case.ts', expectedFailureCode: 'PERSONALITY_FALSE_SUCCESS', timeoutMs: 15000 },
  { id: 'KF-005', status: 'open', caseFile: 'tests/known-failures/cases/kf-005-wav-header.case.ts', expectedFailureCode: 'VOICE_WAV_HEADER_CORRUPT', timeoutMs: 15000 },
  { id: 'KF-006', status: 'open', caseFile: 'tests/known-failures/cases/kf-006-whisper-nonblocking.case.ts', expectedFailureCode: 'WHISPER_EVENT_LOOP_BLOCKED', timeoutMs: 15000 },
  { id: 'KF-007', status: 'open', caseFile: 'tests/known-failures/cases/kf-007-screenshot-dimensions.case.ts', expectedFailureCode: 'SCREENSHOT_DIMENSION_API_MISMATCH', timeoutMs: 15000 },
  { id: 'KF-008', status: 'open', caseFile: 'tests/known-failures/cases/kf-008-robotjs-arguments.case.ts', expectedFailureCode: 'ROBOTJS_ARGUMENT_MISMATCH', timeoutMs: 15000 },
  { id: 'KF-009', status: 'open', caseFile: 'tests/known-failures/cases/kf-009-uia-false-success.case.ts', expectedFailureCode: 'UIA_ACTION_FALSE_SUCCESS', timeoutMs: 15000 },
  { id: 'KF-010', status: 'open', caseFile: 'tests/known-failures/cases/kf-010-permission-bypass.case.ts', expectedFailureCode: 'MANUAL_PATH_PERMISSION_BYPASS', timeoutMs: 15000 },
  { id: 'KF-011', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-011-ssrf-redirect.regression.test.ts', resolvedBy: 'scheme-level guard: checkUrlSafety rejects non-http(s) schemes', timeoutMs: 15000 },
  { id: 'KF-012', status: 'open', caseFile: 'tests/known-failures/cases/kf-012-browser-session-isolation.case.ts', expectedFailureCode: 'BROWSER_CONTEXT_SHARED', timeoutMs: 15000 },
  { id: 'KF-013', status: 'open', caseFile: 'tests/known-failures/cases/kf-013-memory-scope.case.ts', expectedFailureCode: 'MEMORY_SCOPE_LEAK', timeoutMs: 15000 },
  { id: 'KF-014', status: 'open', caseFile: 'tests/known-failures/cases/kf-014-memory-index-consistency.case.ts', expectedFailureCode: 'MEMORY_INDEX_STALE', timeoutMs: 15000 },
  { id: 'KF-015', status: 'open', caseFile: 'tests/known-failures/cases/kf-015-reload-scope-overwrite.case.ts', expectedFailureCode: 'REGISTRATION_SCOPE_OVERWRITE', timeoutMs: 15000 },
  { id: 'KF-016', status: 'open', caseFile: 'tests/known-failures/cases/kf-016-forge-path-normalization.case.ts', expectedFailureCode: 'FORGE_PATH_DOUBLE_JOIN', timeoutMs: 15000 },
  { id: 'KF-017', status: 'open', caseFile: 'tests/known-failures/cases/kf-017-forge-placeholder-verification.case.ts', expectedFailureCode: 'FORGE_PLACEHOLDER_VERIFIED', timeoutMs: 15000 },
  { id: 'KF-018', status: 'open', caseFile: 'tests/known-failures/cases/kf-018-build-static-frontend.case.ts', expectedFailureCode: 'BUILD_STATIC_FRONTEND_MISSING', timeoutMs: 15000 },
  { id: 'KF-019', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-019-build-restart-readback.regression.test.ts', resolvedBy: 'verify engine: 启动→探活→重启→读回闭环', timeoutMs: 15000 },
  { id: 'KF-020', status: 'open', caseFile: 'tests/known-failures/cases/kf-020-evidence-full-sha256.case.ts', expectedFailureCode: 'EVIDENCE_WEAK_FINGERPRINT', timeoutMs: 15000 },
  { id: 'KF-021', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-021-gate-exit-code.regression.test.ts', resolvedBy: 'gate test gate propagates npm test non-zero exit to pass=false', timeoutMs: 60000 },
  { id: 'KF-022', status: 'open', caseFile: 'tests/known-failures/cases/kf-022-scaffold-build-pipeline.case.ts', expectedFailureCode: 'SCAFFOLD_PIPELINE_BYPASS', timeoutMs: 15000 },
  { id: 'KF-023', status: 'open', caseFile: 'tests/known-failures/cases/kf-023-goal-verifier-fail-open.case.ts', expectedFailureCode: 'GOAL_VERIFIER_FAIL_OPEN', timeoutMs: 15000 },
  { id: 'KF-024', status: 'open', caseFile: 'tests/known-failures/cases/kf-024-agent-text-success.case.ts', expectedFailureCode: 'AGENT_TEXT_FALSE_SUCCESS', timeoutMs: 15000 },
  { id: 'KF-025', status: 'open', caseFile: 'tests/known-failures/cases/kf-025-task-kill-effect-fence.case.ts', expectedFailureCode: 'TASK_KILL_EFFECT_CONTINUES', timeoutMs: 15000 },
  { id: 'KF-026', status: 'open', caseFile: 'tests/known-failures/cases/kf-026-hook-fail-closed.case.ts', expectedFailureCode: 'SECURITY_HOOK_FAIL_OPEN', timeoutMs: 15000 },
  { id: 'KF-027', status: 'open', caseFile: 'tests/known-failures/cases/kf-027-wire-readiness.case.ts', expectedFailureCode: 'WIRE_REGISTERED_BEFORE_READY', timeoutMs: 15000 },
  { id: 'KF-028', status: 'open', caseFile: 'tests/known-failures/cases/kf-028-session-restore-gateway.case.ts', expectedFailureCode: 'SESSION_RESTORE_DEFAULTED', timeoutMs: 15000 },
  { id: 'KF-029', status: 'open', caseFile: 'tests/known-failures/cases/kf-029-english-system-prompt.case.ts', expectedFailureCode: 'ENGLISH_PROMPT_CHINESE_CONTROL_TEXT', timeoutMs: 15000 },
  { id: 'KF-030', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-030-schema-version.regression.test.ts', resolvedBy: 'W0-06 db migration registry (schema_version=4 + migration_history)', timeoutMs: 15000 },
] as const;

export function validateKnownFailureRegistry(
  value: unknown,
): { ok: true; entries: KnownFailureEntry[] } | { ok: false; issues: string[] } {
  const rows = Array.isArray(value) ? value : [];
  const issues: string[] = [];
  const counts = new Map<string, number>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') {
      issues.push('KF_ENTRY_INVALID');
      continue;
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '<missing>';
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (row.status === 'open') {
      if (typeof row.caseFile !== 'string' || !row.caseFile.startsWith('tests/known-failures/cases/') ||
          !row.caseFile.endsWith('.case.ts') || typeof row.expectedFailureCode !== 'string' ||
          typeof row.timeoutMs !== 'number' || 'regressionFile' in row || 'resolvedBy' in row) {
        issues.push(`KF_OPEN_SHAPE_INVALID:${id}`);
      }
    } else if (row.status === 'resolved-with-green-regression') {
      if (typeof row.regressionFile !== 'string' ||
          !/^tests\/regressions\/known-failures\/kf-\d{3}-.+\.regression\.test\.ts$/.test(row.regressionFile) ||
          typeof row.resolvedBy !== 'string' || row.resolvedBy.length === 0 ||
          typeof row.timeoutMs !== 'number' || 'caseFile' in row || 'expectedFailureCode' in row) {
        issues.push(`KF_RESOLVED_SHAPE_INVALID:${id}`);
      }
    } else {
      issues.push(`KF_STATUS_INVALID:${id}`);
    }
  }
  for (const id of REQUIRED_KNOWN_FAILURE_IDS) {
    const count = counts.get(id) ?? 0;
    if (count === 0) issues.push(`KF_ID_MISSING:${id}`);
    if (count > 1) issues.push(`KF_ID_DUPLICATE:${id}`);
  }
  for (const id of counts.keys()) {
    if (!REQUIRED_KNOWN_FAILURE_IDS.includes(id as KnownFailureId)) issues.push(`KF_ID_UNEXPECTED:${id}`);
  }
  return issues.length === 0
    ? { ok: true, entries: rows as KnownFailureEntry[] }
    : { ok: false, issues };
}
