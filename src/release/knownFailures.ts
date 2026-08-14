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
  { id: 'KF-003', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-003-setup-wizard.regression.test.ts', resolvedBy: 'R13 bootstrap 真实入口：src/bootstrap/setupWizard.ts（runSetupWizard 唯一向导决策入口，CLI 只经其决策）——首跑 TTY 真实进入 onboarding-required 并持久化 locale；已有 locale/非交互 continue；--help/--version 零副作用保持', timeoutMs: 15000 },
  { id: 'KF-004', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-004-personality-persistence.regression.test.ts', resolvedBy: 'personality 白名单化 + 真实消费：SETTINGS_KEYS 加 personality；buildSystemPrompt 新增 persona 段（settings.personality → 系统提示，CLI/agent 两处接线）——不再假成功（写入即消费）', timeoutMs: 15000 },
  { id: 'KF-005', status: 'open', caseFile: 'tests/known-failures/cases/kf-005-wav-header.case.ts', expectedFailureCode: 'VOICE_WAV_HEADER_CORRUPT', timeoutMs: 15000 },
  { id: 'KF-006', status: 'open', caseFile: 'tests/known-failures/cases/kf-006-whisper-nonblocking.case.ts', expectedFailureCode: 'WHISPER_EVENT_LOOP_BLOCKED', timeoutMs: 15000 },
  { id: 'KF-007', status: 'open', caseFile: 'tests/known-failures/cases/kf-007-screenshot-dimensions.case.ts', expectedFailureCode: 'SCREENSHOT_DIMENSION_API_MISMATCH', timeoutMs: 15000 },
  { id: 'KF-008', status: 'open', caseFile: 'tests/known-failures/cases/kf-008-robotjs-arguments.case.ts', expectedFailureCode: 'ROBOTJS_ARGUMENT_MISMATCH', timeoutMs: 15000 },
  { id: 'KF-009', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-009-uia-false-success.regression.test.ts', resolvedBy: 'UIA 点击兜底真实执行：SetCursorPos + mouse_event（LEFTDOWN/LEFTUP）真实坐标点击；SetCursorPos 失败如实 ok:false——绝不再以 method=focus 谎报动作完成', timeoutMs: 15000 },
  { id: 'KF-010', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-010-permission-bypass.regression.test.ts', resolvedBy: 'fail-closed 默认审批：未装配 onApproval 时一律拒绝（不再默认放行 manual 模式区外写）', timeoutMs: 15000 },
  { id: 'KF-011', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-011-ssrf-redirect.regression.test.ts', resolvedBy: 'scheme-level guard: checkUrlSafety rejects non-http(s) schemes', timeoutMs: 15000 },
  { id: 'KF-012', status: 'open', caseFile: 'tests/known-failures/cases/kf-012-browser-session-isolation.case.ts', expectedFailureCode: 'BROWSER_CONTEXT_SHARED', timeoutMs: 15000 },
  { id: 'KF-013', status: 'open', caseFile: 'tests/known-failures/cases/kf-013-memory-scope.case.ts', expectedFailureCode: 'MEMORY_SCOPE_LEAK', timeoutMs: 15000 },
  { id: 'KF-014', status: 'open', caseFile: 'tests/known-failures/cases/kf-014-memory-index-consistency.case.ts', expectedFailureCode: 'MEMORY_INDEX_STALE', timeoutMs: 15000 },
  { id: 'KF-015', status: 'open', caseFile: 'tests/known-failures/cases/kf-015-reload-scope-overwrite.case.ts', expectedFailureCode: 'REGISTRATION_SCOPE_OVERWRITE', timeoutMs: 15000 },
  { id: 'KF-016', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-016-forge-path-normalization.regression.test.ts', resolvedBy: 'forge 目录组合幂等：outDir basename===组件名时直接落位（不再二次 join）；父目录约定向后兼容', timeoutMs: 15000 },
  { id: 'KF-017', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-017-forge-placeholder-verification.regression.test.ts', resolvedBy: 'registry 状态机：verified 只能经 verify() 携带非空证据进入；installed 须先 verified；撤销（→quarantine）保留', timeoutMs: 15000 },
  { id: 'KF-018', status: 'open', caseFile: 'tests/known-failures/cases/kf-018-build-static-frontend.case.ts', expectedFailureCode: 'BUILD_STATIC_FRONTEND_MISSING', timeoutMs: 15000 },
  { id: 'KF-019', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-019-build-restart-readback.regression.test.ts', resolvedBy: 'verify engine: 启动→探活→重启→读回闭环', timeoutMs: 15000 },
  { id: 'KF-020', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-020-evidence-full-sha256.regression.test.ts', resolvedBy: 'fingerprint 不再截断：完整 SHA-256 64 hex（6 hex 碰撞空间不可接受）；指纹内容敏感 + evidence.json 自免疫语义保持（build-spec 旧断言同步更新）', timeoutMs: 15000 },
  { id: 'KF-021', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-021-gate-exit-code.regression.test.ts', resolvedBy: 'gate test gate propagates npm test non-zero exit to pass=false', timeoutMs: 60000 },
  { id: 'KF-022', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-022-scaffold-build-pipeline.regression.test.ts', resolvedBy: 'instantiate(spec, dir, plan?) 消费 BuildPlan：模块按拓扑序落位（db→api→frontend/app）+ plan.json 落盘（真实消费证据）；/build 与 scaffold_build 两调用点显式传 plan；未传时 makePlan 规则脑兜底（绝不绕过计划）', timeoutMs: 15000 },
  { id: 'KF-023', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-023-goal-verifier-fail-open.regression.test.ts', resolvedBy: 'goal 完成声明须经确定性验证：零验证副作用 + [GOAL_DONE] → incomplete（ok 绝不从文本推导）', timeoutMs: 15000 },
  { id: 'KF-024', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-024-agent-text-success.regression.test.ts', resolvedBy: 'isCompletionClaim 完成声明判定：零验证副作用的「完成了」→ incomplete；普通问答文本不受影响', timeoutMs: 15000 },
  { id: 'KF-025', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-025-task-kill-effect-fence.regression.test.ts', resolvedBy: 'task kill aborts the agent line effect fence; subagent side effects and late results are dropped', timeoutMs: 15000 },
  { id: 'KF-026', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-026-hook-fail-closed.regression.test.ts', resolvedBy: 'security-critical hook decision is structured and fail-closed (crash/timeout/missing/non-zero exit deny)', timeoutMs: 15000 },
  { id: 'KF-027', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-027-wire-readiness.regression.test.ts', resolvedBy: 'W3: wire stdin RPC 帧在 gateway/frontend/订阅全部装配后（wireReady）才分发；ready 前返回 WIRE_GATEWAY_NOT_READY', timeoutMs: 15000 },
  { id: 'KF-028', status: 'open', caseFile: 'tests/known-failures/cases/kf-028-session-restore-gateway.case.ts', expectedFailureCode: 'SESSION_RESTORE_DEFAULTED', timeoutMs: 15000 },
  { id: 'KF-029', status: 'resolved-with-green-regression', regressionFile: 'tests/regressions/known-failures/kf-029-english-system-prompt.regression.test.ts', resolvedBy: 'systemPrompt.ts 零中文重写：全部控制文本迁入 i18n catalog（zh-CN/en 同 key 30+ 条）；lang=en 整段提示无 CJK（源文件级断言）', timeoutMs: 15000 },
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
